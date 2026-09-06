import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    bulkCreateSalesSchema,
    createSaleSchema,
    idParamSchema,
    idempotencyKeySchema,
    listSalesQuerySchema,
    receiptQuerySchema,
    voidSaleSchema,
    createUnreconciledSaleSchema,
    listUnreconciledSalesQuerySchema,
} from '../../schemas';
import * as salesService from '../../services/sales.service';
import * as receiptsService from '../../services/receipts.service';
import * as unreconciledSalesService from '../../services/unreconciled-sales.service';
import { AppError } from '../../utils/errors';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type CreateSaleInput = z.infer<typeof createSaleSchema>;
type BulkCreateSalesInput = z.infer<typeof bulkCreateSalesSchema>;
type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type VoidSaleInput = z.infer<typeof voidSaleSchema>;
type CreateUnreconciledInput = z.infer<typeof createUnreconciledSaleSchema>;
type ListUnreconciledQuery = z.infer<typeof listUnreconciledSalesQuerySchema>;

@Controller('sales')
export class SalesController {
    @Post()
    // Levantar la venta es mostrador (`pos`); anularla no (ver `void`).
    @RequirePermission('pos')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createSaleSchema)) body: CreateSaleInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        // La llave puede llegar en el body o en el header estándar `Idempotency-Key`.
        const rawKey = body.idempotencyKey ?? idempotencyHeader;
        const idempotencyKey = rawKey
            ? new ZodValidationPipe(idempotencyKeySchema).transform(rawKey)
            : undefined;

        const sale = await salesService.createSale({
            ...body,
            idempotencyKey,
            cashierId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: sale };
    }

    /**
     * Empuje del sync local-first del POS: procesa las ventas en el orden en que
     * se capturaron (secuencial, no en paralelo, para no pelear folios) y
     * devuelve un resultado por índice — una venta rechazada no tumba el resto
     * del lote. La `idempotencyKey` de cada una la protege de un reintento por
     * un corte de red a mitad del lote.
     */
    @Post('bulk')
    @RequirePermission('pos')
    @HttpCode(201)
    async bulkCreate(
        @Body(new ZodValidationPipe(bulkCreateSalesSchema)) body: BulkCreateSalesInput,
        @CurrentUser() user: AuthUser,
    ) {
        const results: Array<
            | { ok: true; sale: Awaited<ReturnType<typeof salesService.createSale>> }
            | { ok: false; error: string }
        > = [];

        for (const item of body.items) {
            try {
                const sale = await salesService.createSale({
                    ...item,
                    cashierId: user.uid,
                    roleSlug: user.role.slug,
                });
                results.push({ ok: true, sale });
            } catch (error) {
                const message = error instanceof AppError || error instanceof Error
                    ? error.message
                    : 'Error desconocido';
                results.push({ ok: false, error: message });
            }
        }

        return { data: results };
    }

    /**
     * Venta cobrada en caja que el backend rechazó (stock, producto, turno). No
     * entra a `sales` —descuadraría el inventario— pero el movimiento y el
     * dinero quedan registrados para conciliarse a mano.
     */
    @Post('unreconciled')
    @RequirePermission('pos')
    @HttpCode(201)
    async createUnreconciled(
        @Body(new ZodValidationPipe(createUnreconciledSaleSchema)) body: CreateUnreconciledInput,
        @CurrentUser() user: AuthUser,
    ) {
        const sale = await unreconciledSalesService.recordUnreconciledSale({
            ...body,
            cashierId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: sale };
    }

    @Get('unreconciled')
    @RequirePermission('sales', 'read')
    async listUnreconciled(
        @Query(new ZodValidationPipe(listUnreconciledSalesQuerySchema))
            query: ListUnreconciledQuery,
    ) {
        const result = await unreconciledSalesService.listUnreconciledSales({
            from: query.from,
            to: query.to,
            includeResolved: query.includeResolved === 'true',
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** La marca como atendida; el documento se conserva como rastro. */
    @Post('unreconciled/:id/resolve')
    @RequirePermission('sales')
    async resolveUnreconciled(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        await unreconciledSalesService.resolveUnreconciledSale(params.id, user.uid);
        return { data: { id: params.id, resolved: true } };
    }

    @Get()
    @RequirePermission('sales', 'read')
    async list(
        @Query(new ZodValidationPipe(listSalesQuerySchema)) query: ListSalesQuery,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await salesService.listSales({
            from: query.from,
            to: query.to,
            cashSessionId: query.cashSessionId,
            includeVoided: query.includeVoided,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
            requesterId: user.uid,
            requesterRoleSlug: user.role.slug,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('sales', 'read')
    async get(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const sale = await salesService.getSale(params.id);
        await salesService.assertCanReadSale(sale, user.uid, user.role.slug);
        return { data: sale };
    }

    /** Ticket imprimible: JSON estructurado + HTML para rollo térmico 58/80mm. */
    @Get(':id/receipt')
    @RequirePermission('sales', 'read')
    async receipt(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(receiptQuerySchema)) query: ReceiptQuery,
        @CurrentUser() user: AuthUser,
    ) {
        // El ticket lleva el detalle completo de la venta: mismo control que
        // `GET /sales/:id`.
        const sale = await salesService.getSale(params.id);
        await salesService.assertCanReadSale(sale, user.uid, user.role.slug);
        const receipt = await receiptsService.getSaleReceipt(params.id, query.width);
        return { data: receipt };
    }

    @Post(':id/void')
    /**
     * Piso mínimo: ver ventas. Quién puede anular de verdad lo decide
     * `assertCanVoidSale` (`pos:write` del mostrador **o** `sales:write`),
     * porque el decorador solo admite un área y aquí valen dos. Con
     * `RequirePermission('sales')` —que asume nivel `write`— el guard rechazaba
     * al cajero con 403 antes de llegar al handler.
     */
    @RequirePermission('sales', 'read')
    async void(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
        @Body(new ZodValidationPipe(voidSaleSchema)) body: VoidSaleInput,
    ) {
        salesService.assertCanVoidSale(user);
        const sale = await salesService.voidSale(params.id, user.uid, user.role.slug, body);
        return { data: sale };
    }
}
