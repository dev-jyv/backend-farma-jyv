import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import * as logger from 'firebase-functions/logger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
    createPointOrderSchema,
    createPointPosSchema,
    createPointStoreSchema,
    idParamSchema,
    idempotencyKeySchema,
    listPointDevicesQuerySchema,
    mercadoPagoWebhookQuerySchema,
    refundPointOrderSchema,
    setupPointDeviceSchema,
} from '../../schemas';
import * as mercadoPagoService from '../../services/mercado-pago.service';
import * as directChargesService from '../../services/direct-charges.service';
import * as salesService from '../../services/sales.service';
import * as eventsRepo from '../../repositories/mercado-pago-events.repository';
import { Public } from '../identity/decorators/public.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

type ListDevicesQuery = z.infer<typeof listPointDevicesQuerySchema>;
type SetupDeviceInput = z.infer<typeof setupPointDeviceSchema>;
type CreateStoreInput = z.infer<typeof createPointStoreSchema>;
type CreatePosInput = z.infer<typeof createPointPosSchema>;
type CreatePointOrderInput = z.infer<typeof createPointOrderSchema>;
type RefundPointOrderInput = z.infer<typeof refundPointOrderSchema>;
type WebhookQuery = z.infer<typeof mercadoPagoWebhookQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;

@Controller('payments/mercadopago')
export class PaymentsController {
    @Get('devices')
    @RequirePermission('sales', 'read')
    async devices(
        @Query(new ZodValidationPipe(listPointDevicesQuerySchema)) query: ListDevicesQuery,
    ) {
        const devices = await mercadoPagoService.listDevices({
            storeId: query.storeId,
            posId: query.posId,
        });
        logger.info('Devices fetched', { devices });
        return { data: devices };
    }

    @Patch('devices/operating-mode')
    @RequirePermission('sales')
    async setupOperatingMode(
        @Body(new ZodValidationPipe(setupPointDeviceSchema)) body: SetupDeviceInput,
    ) {
        const device = await mercadoPagoService.setupDeviceOperatingMode({
            deviceId: body.deviceId,
            operatingMode: body.operatingMode,
        });
        return { data: device };
    }

    @Post('stores')
    @RequirePermission('sales')
    async createStore(
        @Body(new ZodValidationPipe(createPointStoreSchema)) body: CreateStoreInput,
    ) {
        const store = await mercadoPagoService.createStore(body);
        return { data: store };
    }

    @Post('pos')
    @RequirePermission('sales')
    async createPos(
        @Body(new ZodValidationPipe(createPointPosSchema)) body: CreatePosInput,
    ) {
        const pos = await mercadoPagoService.createPos(body);
        return { data: pos };
    }

    @Post('orders')
    // Cobrar con la terminal es parte de levantar la venta.
    @RequirePermission('pos')
    async createOrder(
        @Body(new ZodValidationPipe(createPointOrderSchema)) body: CreatePointOrderInput,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        const rawKey = body.idempotencyKey ?? idempotencyHeader;
        const idempotencyKey = rawKey
            ? new ZodValidationPipe(idempotencyKeySchema).transform(rawKey)
            : undefined;

        const order = await mercadoPagoService.createOrder({
            deviceId: body.deviceId,
            amount: body.amount,
            externalReference: body.externalReference,
            description: body.description,
            expirationTime: body.expirationTime,
            printOnTerminal: body.printOnTerminal,
            idempotencyKey,
        });
        return { data: order };
    }

    @Get('orders/:id')
    @RequirePermission('sales', 'read')
    async getOrder(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const order = await mercadoPagoService.getOrder(params.id);
        return { data: order };
    }

    @Delete('orders/:id')
    // Cancelar el cobro pendiente sí; reembolsar uno ya cobrado no (ver `refundOrder`).
    @RequirePermission('pos')
    async cancelOrder(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        await mercadoPagoService.cancelOrder(params.id);
        return { data: { id: params.id, canceled: true } };
    }

    @Post('orders/:id/refund')
    @RequirePermission('sales')
    async refundOrder(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(refundPointOrderSchema)) body: RefundPointOrderInput,
    ) {
        const order = await mercadoPagoService.refundOrder({
            orderId: params.id,
            paymentId: body.paymentId,
            amount: body.amount,
        });
        return { data: order };
    }

    @Public()
    @Post('webhooks')
    async webhook(
        @Query(new ZodValidationPipe(mercadoPagoWebhookQuerySchema)) query: WebhookQuery,
        @Headers('x-signature') xSignature?: string,
        @Headers('x-request-id') xRequestId?: string,
    ) {
        const dataId = query['data.id'] ?? query.id;
        mercadoPagoService.verifyWebhookSignature({
            xSignature,
            xRequestId,
            dataId,
        });
        const type = query.type ?? query.topic;

        // Mercado Pago reenvía cada aviso hasta recibir un 200. El `x-request-id`
        // identifica el envío: si ya se procesó, se contesta 200 sin repetir el
        // trabajo, y en cualquier caso queda la constancia de qué llegó.
        if (xRequestId) {
            const isNew = await eventsRepo.registerWebhookEvent({
                requestId: xRequestId,
                type: type ?? null,
                dataId: dataId ?? null,
            });
            if (!isNew) {
                return { data: { received: true, duplicate: true } };
            }
        }

        const outcome = await this.resolveWebhook(type, dataId);
        if (xRequestId) {
            await eventsRepo.markWebhookEventHandled(xRequestId, outcome);
        }
        return { data: { received: true, ...outcome } };
    }

    /** Resuelve el aviso contra lo que el POS sí conoce: cobros directos y ventas. */
    private async resolveWebhook(
        type: string | undefined,
        dataId: string | undefined,
    ): Promise<Record<string, unknown>> {
        if (!dataId) {
            return { handled: false };
        }

        // Aviso de pago: puede ser un cobro en línea (Checkout Pro). Se resuelve
        // aquí para no depender de que la caja siga preguntando —el cajero puede
        // haber cerrado la pantalla— y es idempotente: aplicar el mismo pago dos
        // veces deja el cobro igual.
        if (type === 'payment') {
            const charge = await this.safely('pago', dataId, () =>
                directChargesService.syncOnlineChargeFromPayment(dataId),
            );
            return charge ? { directChargeId: charge.id } : { handled: false };
        }

        // Orden comercial de Checkout Pro: el mismo cobro en línea visto desde la
        // `merchant_order`. Es la red de seguridad cuando el aviso de `payment` no
        // llega o llega antes de que el pago sea consultable.
        const isMerchantOrder = type === 'merchant_order' ||
            type === 'merchant_order_wh' ||
            type === 'topic_merchant_order_wh';
        if (isMerchantOrder) {
            const charge = await this.safely('merchant order', dataId, () =>
                directChargesService.syncOnlineChargeFromMerchantOrder(dataId),
            );
            return charge ? { directChargeId: charge.id } : { handled: false };
        }

        if (mercadoPagoService.isOrderTopic(type)) {
            // Cobro directo con terminal: es lo único que cierra el caso de una
            // cancelación hecha **en la terminal**, que la API no permite cancelar
            // y el sondeo no ve si el cajero ya cerró la pantalla.
            const charge = await this.safely('orden', dataId, () =>
                directChargesService.syncPointChargeFromOrder(dataId),
            );
            if (charge) {
                return { directChargeId: charge.id };
            }

            // Si la orden no es de un cobro directo, puede ser de una venta: el
            // estado del cobro cambia del lado de Mercado Pago (reembolso,
            // contracargo) y la venta debe reflejarlo.
            const sale = await this.safely('venta', dataId, () =>
                salesService.syncPointPaymentFromOrder(dataId),
            );
            if (sale) {
                return { saleId: sale.id };
            }

            const result = await mercadoPagoService.handleWebhookNotification({ dataId, type });
            if (result.order?.status === 'processed') {
                // Orden pagada sin venta ni cobro directo detrás: es dinero cobrado
                // que el POS no registró. No se puede resolver solo; se deja visible.
                logger.error('Orden de Mercado Pago aprobada sin venta ni cobro directo asociado', {
                    orderId: dataId,
                    externalReference: result.order.externalReference,
                    amount: result.order.amount,
                });
                return { handled: false, orphanOrderId: dataId };
            }
            return { handled: false };
        }

        return { handled: false };
    }

    /** Un fallo resolviendo el aviso no debe provocar que Mercado Pago reintente para siempre. */
    private async safely<T>(
        what: string,
        dataId: string,
        run: () => Promise<T | null>,
    ): Promise<T | null> {
        try {
            return await run();
        } catch (error) {
            logger.error(`No se pudo resolver el webhook de ${what}`, { dataId, error });
            return null;
        }
    }
}
