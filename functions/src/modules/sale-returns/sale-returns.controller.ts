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
    createSaleReturnSchema,
    idParamSchema,
    idempotencyKeySchema,
    listSaleReturnsQuerySchema,
    receiptQuerySchema,
} from '../../schemas';
import * as saleReturnsService from '../../services/sale-returns.service';
import * as receiptsService from '../../services/receipts.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type CreateSaleReturnInput = z.infer<typeof createSaleReturnSchema>;
type ListSaleReturnsQuery = z.infer<typeof listSaleReturnsQuerySchema>;
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;

@Controller('sale-returns')
export class SaleReturnsController {
    @Post()
    @RequirePermission('sales')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createSaleReturnSchema)) body: CreateSaleReturnInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        const rawKey = body.idempotencyKey ?? idempotencyHeader;
        const idempotencyKey = rawKey
            ? new ZodValidationPipe(idempotencyKeySchema).transform(rawKey)
            : undefined;

        const saleReturn = await saleReturnsService.createSaleReturn({
            ...body,
            idempotencyKey,
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: saleReturn };
    }

    @Get()
    @RequirePermission('sales', 'read')
    async list(
        @Query(new ZodValidationPipe(listSaleReturnsQuerySchema)) query: ListSaleReturnsQuery,
    ) {
        const items = await saleReturnsService.listSaleReturns(query);
        return { data: items };
    }

    @Get(':id')
    @RequirePermission('sales', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const saleReturn = await saleReturnsService.getSaleReturn(params.id);
        return { data: saleReturn };
    }

    @Get(':id/receipt')
    @RequirePermission('sales', 'read')
    async receipt(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(receiptQuerySchema)) query: ReceiptQuery,
    ) {
        const receipt = await receiptsService.getSaleReturnReceipt(params.id, query.width);
        return { data: receipt };
    }
}
