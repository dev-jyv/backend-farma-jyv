import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import {
    bulkCreateEntriesSchema,
    directInventoryEntrySchema,
    idParamSchema,
    inventoryEntrySchema,
    inventoryAlertsQuerySchema,
    inventoryExitSchema,
    createInventoryCountSchema,
    listBatchesQuerySchema,
    exportControlledLedgerQuerySchema,
    listControlledLedgerQuerySchema,
    listInventoryCountsQuerySchema,
    scanCodeSchema,
    listEntriesQuerySchema,
    listMovementsQuerySchema,
} from '../../schemas';
import * as inventoryService from '../../services/inventory.service';
import { bulkCreateEntriesIdempotent, runIdempotentEntry } from '../../services/entry-idempotency.service';
import { idempotencyKeySchema } from '../../schemas/sales';
import * as alertsService from '../../services/inventory-alerts.service';
import * as countsService from '../../services/inventory-counts.service';
import * as controlledService from '../../services/controlled.service';
import * as scanService from '../../services/scan.service';
import * as summaryService from '../../services/inventory-summary.service';
import { hasPermission } from '../../constants/permissions';
import { AuthUser } from '../../types';
import { forbidden } from '../../utils/errors';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>;
type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type InventoryEntryInput = z.infer<typeof inventoryEntrySchema>;
type DirectInventoryEntryInput = z.infer<typeof directInventoryEntrySchema>;
type BulkCreateEntriesInput = z.infer<typeof bulkCreateEntriesSchema>;
type InventoryExitInput = z.infer<typeof inventoryExitSchema>;
type InventoryAlertsQuery = z.infer<typeof inventoryAlertsQuerySchema>;
type CreateInventoryCountInput = z.infer<typeof createInventoryCountSchema>;
type ListInventoryCountsQuery = z.infer<typeof listInventoryCountsQuerySchema>;
type ListControlledLedgerQuery = z.infer<typeof listControlledLedgerQuerySchema>;
type ScanCodeInput = z.infer<typeof scanCodeSchema>;
type ExportControlledLedgerQuery = z.infer<typeof exportControlledLedgerQuerySchema>;

/** La llave puede llegar en el body o en el header estándar `Idempotency-Key`. */
const resolveIdempotencyKey = (
    bodyKey: string | undefined,
    header: string | undefined,
): string | undefined => {
    const raw = bodyKey ?? header;
    return raw ? new ZodValidationPipe(idempotencyKeySchema).transform(raw) : undefined;
};

@Controller('inventory')
export class InventoryController {
    @Get('batches')
    @RequirePermission('inventory', 'read')
    async listBatches(
        @Query(new ZodValidationPipe(listBatchesQuerySchema)) query: ListBatchesQuery,
    ) {
        const result = await inventoryService.listBatches(query.productId, {
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /**
     * Resuelve un código escaneado (GS1-128 / DataMatrix o EAN plano) y devuelve el
     * producto y el ítem de entrada precargado con lote y caducidad del código.
     */
    @Post('scan')
    @RequirePermission('inventory', 'read')
    @HttpCode(200)
    async scan(@Body(new ZodValidationPipe(scanCodeSchema)) body: ScanCodeInput) {
        const result = await scanService.resolveScannedCode(body.code);
        return { data: result };
    }

    /** Caducidades (vencido + ventanas de días) y stock bajo / agotado. */
    @Get('alerts')
    @RequirePermission('inventory', 'read')
    async alerts(
        @Query(new ZodValidationPipe(inventoryAlertsQuerySchema)) query: InventoryAlertsQuery,
    ) {
        const alerts = await alertsService.getInventoryAlerts({
            expiryWindows: query.windows,
        });
        return { data: alerts };
    }

    /** Valor a costo y a precio de venta, rotación y dinero en riesgo, a hoy. */
    @Get('summary')
    @RequirePermission('inventory', 'read')
    async summary() {
        return { data: await summaryService.getInventorySummary() };
    }

    /** Conteo físico: ajusta los lotes contados y deja movimiento `adjustment_count`. */
    @Post('counts')
    @RequirePermission('inventory')
    @HttpCode(201)
    async createCount(
        @Body(new ZodValidationPipe(createInventoryCountSchema)) body: CreateInventoryCountInput,
        @CurrentUser() user: AuthUser,
    ) {
        const count = await countsService.recordInventoryCount({
            ...body,
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: count };
    }

    @Get('counts')
    @RequirePermission('inventory', 'read')
    async listCounts(
        @Query(new ZodValidationPipe(listInventoryCountsQuerySchema))
            query: ListInventoryCountsQuery,
    ) {
        const result = await countsService.listInventoryCounts({
            productId: query.productId,
            from: query.from,
            to: query.to,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get('counts/:id')
    @RequirePermission('inventory', 'read')
    async getCount(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const count = await countsService.getInventoryCount(params.id);
        return { data: count };
    }

    /** Libro de control de medicamentos controlados (COFEPRIS). */
    @Get('controlled-ledger')
    @RequirePermission('inventory', 'read')
    async controlledLedger(
        @Query(new ZodValidationPipe(listControlledLedgerQuerySchema))
            query: ListControlledLedgerQuery,
    ) {
        const result = await controlledService.listControlledLedger({
            saleId: query.saleId,
            productId: query.productId,
            group: query.group,
            from: query.from,
            to: query.to,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /**
     * Libro de control completo del periodo en CSV, sin paginar: es el archivo que
     * se entrega y se firma en una visita de COFEPRIS. Responde el archivo crudo,
     * no el envoltorio `{ data }`.
     */
    @Get('controlled-ledger/export')
    @RequirePermission('inventory', 'read')
    async exportControlledLedger(
        @Query(new ZodValidationPipe(exportControlledLedgerQuerySchema))
            query: ExportControlledLedgerQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        const { filename, csv } = await controlledService.exportControlledLedger({
            ...query,
            roleSlug: user.role.slug,
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    }

    @Post('entries')
    @RequirePermission('inventory')
    @HttpCode(201)
    async recordEntry(
        @Body(new ZodValidationPipe(inventoryEntrySchema)) body: InventoryEntryInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        const entry = await runIdempotentEntry({
            userId: user.uid,
            scope: 'invoice-entry',
            key: resolveIdempotencyKey(body.idempotencyKey, idempotencyHeader),
            // La entrada se guarda en una sola transacción: si falla, no quedó nada.
            releaseOnFailure: true,
            run: () =>
                inventoryService.recordEntry({
                    invoiceId: body.invoiceId,
                    items: body.products,
                    userId: user.uid,
                }),
        });
        return { data: entry };
    }

    // Bug (a): crear un producto inline aquí requiere products:write además de
    // inventory:write - de lo contrario un rol solo-inventario podría dar de
    // alta productos arbitrarios en el catálogo.
    @Post('direct-entries')
    @RequirePermission('inventory')
    @HttpCode(201)
    async recordDirectEntry(
        @Body(new ZodValidationPipe(directInventoryEntrySchema)) body: DirectInventoryEntryInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        const hasInlineProduct = body.items.some((item) => item.product);
        if (hasInlineProduct) {
            const canCreateProducts = hasPermission(
                user.permissions,
                'products',
                'write',
                user.role.slug,
            );
            if (!canCreateProducts) {
                throw forbidden();
            }
        }

        const entry = await runIdempotentEntry({
            userId: user.uid,
            scope: 'direct-entry',
            key: resolveIdempotencyKey(body.idempotencyKey, idempotencyHeader),
            // El alta de un producto nuevo ocurre antes y fuera de la transacción de
            // la entrada: tras un fallo con productos inline la llave se conserva y
            // el reintento pide revisión en vez de duplicar altas.
            releaseOnFailure: !hasInlineProduct,
            run: () =>
                inventoryService.recordDirectEntry({
                    supplierId: body.supplierId,
                    notes: body.notes,
                    items: body.items,
                    userId: user.uid,
                }),
        });
        return { data: entry };
    }

    @Post('entries/bulk')
    @RequirePermission('inventory')
    @HttpCode(201)
    async bulkCreateEntries(
        @Body(new ZodValidationPipe(bulkCreateEntriesSchema)) body: BulkCreateEntriesInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        const result = await bulkCreateEntriesIdempotent({
            userId: user.uid,
            key: resolveIdempotencyKey(body.idempotencyKey, idempotencyHeader),
            entries: body.entries,
        });
        return { data: result };
    }

    @Get('entries')
    @RequirePermission('inventory', 'read')
    async listEntries(
        @Query(new ZodValidationPipe(listEntriesQuerySchema)) query: ListEntriesQuery,
    ) {
        const result = await inventoryService.listEntries({
            supplierId: query.supplierId,
            invoiceId: query.invoiceId,
            from: query.from,
            to: query.to,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get('entries/:id')
    @RequirePermission('inventory', 'read')
    async getEntry(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const entry = await inventoryService.getEntry(params.id);
        return { data: entry };
    }

    @Post('exits')
    @RequirePermission('inventory')
    @HttpCode(201)
    async recordExit(
        @Body(new ZodValidationPipe(inventoryExitSchema)) body: InventoryExitInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await inventoryService.recordExit({ ...body, userId: user.uid });
        return { data: result };
    }

    @Get('movements')
    @RequirePermission('inventory', 'read')
    async listMovements(
        @Query(new ZodValidationPipe(listMovementsQuerySchema)) query: ListMovementsQuery,
    ) {
        const result = await inventoryService.listMovements({
            productId: query.productId,
            type: query.type,
            from: query.from,
            to: query.to,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }
}
