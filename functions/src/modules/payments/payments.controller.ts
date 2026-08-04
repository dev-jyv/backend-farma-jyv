import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
    createPointOrderSchema,
    createPointPosSchema,
    createPointStoreSchema,
    idParamSchema,
    listPointDevicesQuerySchema,
    mercadoPagoWebhookQuerySchema,
    refundPointOrderSchema,
    setupPointDeviceSchema,
} from '../../schemas';
import * as mercadoPagoService from '../../services/mercado-pago.service';
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
    @RequirePermission('sales')
    async createOrder(
        @Body(new ZodValidationPipe(createPointOrderSchema)) body: CreatePointOrderInput,
    ) {
        const order = await mercadoPagoService.createOrder({
            deviceId: body.deviceId,
            amount: body.amount,
            externalReference: body.externalReference,
            description: body.description,
            expirationTime: body.expirationTime,
            printOnTerminal: body.printOnTerminal,
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
    @RequirePermission('sales')
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
        const result = await mercadoPagoService.handleWebhookNotification({
            dataId,
            type: query.type ?? query.topic,
        });
        return { data: result };
    }
}
