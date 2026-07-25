import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createSaleSchema, idParamSchema, listSalesQuerySchema } from '../../schemas';
import * as salesService from '../../services/sales.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type CreateSaleInput = z.infer<typeof createSaleSchema>;
type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;

@Controller('sales')
export class SalesController {
    @Post()
    @RequirePermission('sales')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createSaleSchema)) body: CreateSaleInput,
        @CurrentUser() user: AuthUser,
    ) {
        const sale = await salesService.createSale({ ...body, cashierId: user.uid });
        return { data: sale };
    }

    @Get()
    @RequirePermission('sales', 'read')
    async list(@Query(new ZodValidationPipe(listSalesQuerySchema)) query: ListSalesQuery) {
        const result = await salesService.listSales({
            from: query.from,
            to: query.to,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('sales', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const sale = await salesService.getSale(params.id);
        return { data: sale };
    }
}
