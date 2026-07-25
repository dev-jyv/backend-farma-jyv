import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    bulkCreateEntriesSchema,
    directInventoryEntrySchema,
    idParamSchema,
    inventoryEntrySchema,
    inventoryExitSchema,
    listBatchesQuerySchema,
    listEntriesQuerySchema,
    listMovementsQuerySchema,
} from '../../schemas';
import * as inventoryService from '../../services/inventory.service';
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
