import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createInvoiceSchema, idParamSchema, listInvoicesQuerySchema } from '../../schemas';
import * as invoicesService from '../../services/invoices.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

@Controller('invoices')
export class InvoicesController {
    @Get()
    @RequirePermission('invoices', 'read')
    async list(
        @Query(new ZodValidationPipe(listInvoicesQuerySchema)) query: ListInvoicesQuery,
    ) {
        const result = await invoicesService.listInvoices({
            supplierId: query.supplierId,
            from: query.from,
            to: query.to,
            hasInvoice: query.hasInvoice === 'true'
                ? true
                : query.hasInvoice === 'false'
                    ? false
                    : undefined,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('invoices', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const invoice = await invoicesService.getInvoice(params.id);
        return { data: invoice };
    }

    @Post()
    @RequirePermission('invoices')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
        @CurrentUser() user: AuthUser,
    ) {
        const invoice = await invoicesService.createInvoice({ ...body, userId: user.uid });
        return { data: invoice };
    }
}
