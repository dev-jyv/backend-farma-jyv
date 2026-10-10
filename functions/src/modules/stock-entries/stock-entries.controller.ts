import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createStockEntrySchema, listRecentInvoicesQuerySchema } from '../../schemas';
import * as stockEntriesService from '../../services/stock-entries.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type CreateStockEntryInput = z.infer<typeof createStockEntrySchema>;
type ListRecentInvoicesQuery = z.infer<typeof listRecentInvoicesQuerySchema>;

/**
 * Recepción de mercancía desde la caja. Superficie propia y acotada: el
 * mostrador registra una partida contra una factura ya dada de alta, y nada más.
 * Subir facturas, hacer conteos o registrar salidas siguen siendo del panel, con
 * `invoices:write` e `inventory:write`.
 */
@Controller('stock-entries')
export class StockEntriesController {
    /** Selector de la caja: las últimas facturas registradas, con su proveedor. */
    @Get('invoices')
    @RequirePermission('stockEntry', 'read')
    async recentInvoices(
        @Query(new ZodValidationPipe(listRecentInvoicesQuerySchema)) query: ListRecentInvoicesQuery,
    ) {
        const invoices = await stockEntriesService.listRecentInvoices(
            query.limit ? Number(query.limit) : undefined,
        );
        return { data: invoices };
    }

    @Post()
    @RequirePermission('stockEntry')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createStockEntrySchema)) body: CreateStockEntryInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await stockEntriesService.createStockEntry({
            ...body,
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: result };
    }
}
