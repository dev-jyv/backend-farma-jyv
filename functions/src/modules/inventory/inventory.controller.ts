import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
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
    listControlledLedgerQuerySchema,
    listInventoryCountsQuerySchema,
    scanCodeSchema,
    listEntriesQuerySchema,
    listMovementsQuerySchema,
} from '../../schemas';
import * as inventoryService from '../../services/inventory.service';
import * as alertsService from '../../services/inventory-alerts.service';
import * as countsService from '../../services/inventory-counts.service';
import * as controlledService from '../../services/controlled.service';
import * as scanService from '../../services/scan.service';
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

    @Post('entries')
    @RequirePermission('inventory')
    @HttpCode(201)
    async recordEntry(
        @Body(new ZodValidationPipe(inventoryEntrySchema)) body: InventoryEntryInput,
        @CurrentUser() user: AuthUser,
    ) {
        const entry = await inventoryService.recordEntry({
            invoiceId: body.invoiceId,
            items: body.products,
            userId: user.uid,
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

        const entry = await inventoryService.recordDirectEntry({
            supplierId: body.supplierId,
            notes: body.notes,
            items: body.items,
            userId: user.uid,
        });
        return { data: entry };
    }

    @Post('entries/bulk')
    @RequirePermission('inventory')
    @HttpCode(201)
    async bulkCreateEntries(
        @Body(new ZodValidationPipe(bulkCreateEntriesSchema)) body: BulkCreateEntriesInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await inventoryService.bulkCreateEntries(body.entries, user.uid);
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
