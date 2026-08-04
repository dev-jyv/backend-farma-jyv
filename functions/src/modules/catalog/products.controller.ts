import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    bulkCreateProductsSchema,
    createProductSchema,
    idParamSchema,
    listProductHistoryQuerySchema,
    listProductsQuerySchema,
    updateProductPricesSchema,
    updateProductSchema,
} from '../../schemas';
import * as productsService from '../../services/products.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
type ListProductHistoryQuery = z.infer<typeof listProductHistoryQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateProductInput = z.infer<typeof createProductSchema>;
type BulkCreateProductsInput = z.infer<typeof bulkCreateProductsSchema>;
type UpdateProductPricesInput = z.infer<typeof updateProductPricesSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;

@Controller('products')
export class ProductsController {
    @Get()
    @RequirePermission('products', 'read')
    async list(@Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQuery) {
        const result = await productsService.listProducts({
            categoryId: query.categoryId,
            search: query.search,
            activeOnly: query.activeOnly !== 'false',
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id/purchase-history')
    @RequirePermission('products', 'read')
    async purchaseHistory(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(listProductHistoryQuerySchema)) query: ListProductHistoryQuery,
    ) {
        const result = await productsService.getProductPurchaseHistory(params.id, {
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id/sales-history')
    @RequirePermission('products', 'read')
    async salesHistory(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(listProductHistoryQuerySchema)) query: ListProductHistoryQuery,
    ) {
        const result = await productsService.getProductSalesHistory(params.id, {
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id/invoice-history')
    @RequirePermission('products', 'read')
    async invoiceHistory(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(listProductHistoryQuerySchema)) query: ListProductHistoryQuery,
    ) {
        const result = await productsService.getProductInvoiceHistory(params.id, {
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Get(':id')
    @RequirePermission('products', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const product = await productsService.getProduct(params.id);
        return { data: product };
    }

    @Post()
    @RequirePermission('products')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
        @CurrentUser() user: AuthUser,
    ) {
        const product = await productsService.createProduct({
            ...body,
            actor: { userId: user.uid, roleSlug: user.role.slug },
        });
        return { data: product };
    }

    @Post('bulk')
    @RequirePermission('products')
    @HttpCode(201)
    async bulkCreate(
        @Body(new ZodValidationPipe(bulkCreateProductsSchema)) body: BulkCreateProductsInput,
    ) {
        const result = await productsService.bulkCreateProducts(body.items);
        return { data: result };
    }

    @Patch('prices')
    @RequirePermission('products')
    async updatePrices(
        @Body(new ZodValidationPipe(updateProductPricesSchema)) body: UpdateProductPricesInput,
        @CurrentUser() user: AuthUser,
    ) {
        const products = await productsService.updateProductPrices(
            body.items,
            { userId: user.uid, roleSlug: user.role.slug },
        );
        return { data: products };
    }

    @Patch(':id')
    @RequirePermission('products')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
        @CurrentUser() user: AuthUser,
    ) {
        const product = await productsService.updateProduct(params.id, body, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: product };
    }

    @Delete(':id')
    @RequirePermission('products')
    async remove(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const product = await productsService.deleteProduct(params.id, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: product };
    }
}
