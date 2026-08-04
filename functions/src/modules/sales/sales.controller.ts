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
    createSaleSchema,
    idParamSchema,
    idempotencyKeySchema,
    listSalesQuerySchema,
    receiptQuerySchema,
} from '../../schemas';
import * as salesService from '../../services/sales.service';
import * as receiptsService from '../../services/receipts.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type CreateSaleInput = z.infer<typeof createSaleSchema>;
type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;

@Controller('sales')
export class SalesController {
    @Post()
    @RequirePermission('sales')
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

    @Get()
    @RequirePermission('sales', 'read')
    async list(@Query(new ZodValidationPipe(listSalesQuerySchema)) query: ListSalesQuery) {
        const result = await salesService.listSales({
            from: query.from,
            to: query.to,
            cashSessionId: query.cashSessionId,
            includeVoided: query.includeVoided,
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

    /** Ticket imprimible: JSON estructurado + HTML para rollo térmico 58/80mm. */
    @Get(':id/receipt')
    @RequirePermission('sales', 'read')
    async receipt(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(receiptQuerySchema)) query: ReceiptQuery,
    ) {
        const receipt = await receiptsService.getSaleReceipt(params.id, query.width);
        return { data: receipt };
    }

    @Post(':id/void')
    @RequirePermission('sales')
    async void(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        salesService.assertCanVoidSale(user.role.slug);
        const sale = await salesService.voidSale(params.id, user.uid);
        return { data: sale };
    }
}
