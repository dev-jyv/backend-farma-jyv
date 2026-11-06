import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Logger,
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
import { SaleResponse, toSaleResponse } from '../../utils/sale-response';
import * as receiptsService from '../../services/receipts.service';
import * as unreconciledSalesService from '../../services/unreconciled-sales.service';
import { badRequest, describeSyncError } from '../../utils/errors';
import { SyncErrorCode } from '../../constants/sync-error-codes';
import { requiresIdempotencyKey } from '../../config/env';
import { AuthUser } from '../../types';
import { hasPermission } from '../../constants/permissions';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import {
    formatZodError,
    spanishZodErrorMap,
    ZodValidationPipe,
} from '../../common/zod-validation.pipe';

type CreateSaleInput = z.infer<typeof createSaleSchema>;
type BulkCreateSalesInput = z.infer<typeof bulkCreateSalesSchema>;
type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type VoidSaleInput = z.infer<typeof voidSaleSchema>;
type CreateUnreconciledInput = z.infer<typeof createUnreconciledSaleSchema>;
type ListUnreconciledQuery = z.infer<typeof listUnreconciledSalesQuerySchema>;

/**
 * Sin llave, un reintento por corte de red vuelve a cobrar y a descontar stock.
 * Mientras `SALES_REQUIRE_IDEMPOTENCY_KEY` está apagada esto solo avisa —el POS
 * de escritorio es otro despliegue y encenderla antes de que la mande dejaría a
 * la farmacia sin cobrar—; con la bandera puesta, rechaza.
 */
const logger = new Logger('SalesIdempotency');
const bulkLogger = new Logger('SalesBulk');

/**
 * Presupuesto del lote (SPEC 48): la función vive 60 s y, si el lote no responde
 * a tiempo, la caja no recibe ningún resultado y reintenta todo. A los 40 s lo
 * que falte se devuelve `DEFERRED` sin procesarse y la caja lo manda en el
 * siguiente envío. Se mide desde que la petición llega al handler.
 */
export const SALES_BULK_BUDGET_MS = 40_000;

type BulkSaleResult =
    | { ok: true; sale: SaleResponse }
    | { ok: false; error: string; code: SyncErrorCode; retryable: boolean };

const assertIdempotencyKey = (key: string | undefined, userId: string): void => {
    if (key) {
        return;
    }
    if (requiresIdempotencyKey()) {
        throw badRequest(
            'Falta la llave de idempotencia del cobro (`idempotencyKey` o header ' +
            '`Idempotency-Key`)',
        );
    }
    logger.warn(
        `Venta sin llave de idempotencia (cajero ${userId}): un reintento por corte ` +
        'de red puede duplicar el cobro.',
    );
};

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

        assertIdempotencyKey(idempotencyKey, user.uid);

        const sale = await salesService.createSale({
            ...body,
            idempotencyKey,
            cashierId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: toSaleResponse(sale) };
    }

    /**
     * Presupuesto del lote en ms. Propiedad de la instancia para que una prueba
     * lo fuerce (a 0 ms: todo `DEFERRED` y nada escrito) sin tocar el reloj.
     */
    bulkBudgetMs = SALES_BULK_BUDGET_MS;

    /**
     * Empuje del sync local-first del POS: procesa las ventas en el orden en que
     * se capturaron (secuencial, no en paralelo, para no pelear folios) y
     * devuelve un resultado por índice — una venta rechazada no tumba el resto
     * del lote. La `idempotencyKey` de cada una la protege de un reintento por
     * un corte de red a mitad del lote.
     *
     * SPEC 48: cada venta se valida aquí (`safeParse`), así una inválida responde
     * `VALIDATION` solo en su índice; y al agotarse el presupuesto las restantes
     * responden `DEFERRED` reintentable sin procesarse.
     */
    @Post('bulk')
    @RequirePermission('pos')
    @HttpCode(201)
    async bulkCreate(
        @Body(new ZodValidationPipe(bulkCreateSalesSchema)) body: BulkCreateSalesInput,
        @CurrentUser() user: AuthUser,
    ) {
        const deadline = Date.now() + this.bulkBudgetMs;
        const results: BulkSaleResult[] = [];
        const callerHasPosWrite = hasPermission(
            user.permissions ?? [],
            'pos',
            'write',
            user.role.slug,
        );

        for (const rawItem of body.items) {
            if (Date.now() >= deadline) {
                results.push({
                    ok: false,
                    code: 'DEFERRED',
                    error: 'El lote no alcanzó a procesar esta venta; se enviará en el ' +
                        'siguiente intento',
                    retryable: true,
                });
                continue;
            }

            const parsed = createSaleSchema.safeParse(rawItem, {
                errorMap: spanishZodErrorMap,
            });
            if (!parsed.success) {
                results.push({
                    ok: false,
                    code: 'VALIDATION',
                    error: formatZodError(parsed.error),
                    retryable: false,
                });
                continue;
            }
            const item = parsed.data;

            try {
                // Con la bandera encendida cada venta del lote exige su llave: un
                // reintento del lote completo (corte de red, timeout de 60 s) ya no
                // duplica cobro, stock y efectivo de las que sí se habían guardado.
                assertIdempotencyKey(item.idempotencyKey ?? undefined, user.uid);
                const sale = await salesService.createSale({
                    ...item,
                    cashierId: user.uid,
                    roleSlug: user.role.slug,
                    offline: true,
                    // `soldBy` (SPEC 54) solo vale para quien puede vender.
                    callerHasPosWrite,
                });
                results.push({ ok: true, sale: toSaleResponse(sale) });
            } catch (error) {
                // Contrato de SPEC 49: la caja decide por `code` y `retryable`, no por
                // el texto. Lo que no es un rechazo de negocio (un `ABORTED` de
                // Firestore tras sus reintentos, un 5xx) sale `INTERNAL` reintentable.
                const { code, retryable, message } = describeSyncError(error);
                if (code === 'INTERNAL') {
                    // El lote se traga el error para seguir con las demás ventas: sin
                    // este registro un 500 dentro del bulk no dejaba rastro.
                    bulkLogger.error(
                        `Venta del lote no procesada (cajero ${user.uid}): ` +
                        (error instanceof Error ? error.stack ?? error.message : String(error)),
                    );
                }
                results.push({ ok: false, error: message, code, retryable });
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
            promotionReview: query.promotionReview,
            review: query.review,
            paymentMethod: query.paymentMethod,
            after: query.after,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
            requesterId: user.uid,
            requesterRoleSlug: user.role.slug,
        });
        return { data: result.items.map(toSaleResponse), meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('sales', 'read')
    async get(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const sale = await salesService.getSale(params.id);
        await salesService.assertCanReadSale(sale, user.uid, user.role.slug);
        return { data: toSaleResponse(sale) };
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
        return { data: toSaleResponse(sale) };
    }
}
