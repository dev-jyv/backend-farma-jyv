import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createSupplierSchema,
    idParamSchema,
    syncSuppliersQuerySchema,
    listSuppliersQuerySchema,
    updateSupplierSchema,
} from '../../schemas';
import * as suppliersService from '../../services/suppliers.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;
type SyncSuppliersQuery = z.infer<typeof syncSuppliersQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

@Controller('suppliers')
export class SuppliersController {
    @Get()
    @RequirePermission('suppliers', 'read')
    async list(
        @Query(new ZodValidationPipe(listSuppliersQuerySchema)) query: ListSuppliersQuery,
    ) {
        const result = await suppliersService.listSuppliers({
            activeOnly: query.activeOnly !== 'false',
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Catálogo completo sin paginar. Declarado antes de `:id`, que si no lo captura. */
    @Get('sync')
    @RequirePermission('suppliers', 'read')
    async sync(
        @Query(new ZodValidationPipe(syncSuppliersQuerySchema)) query: SyncSuppliersQuery,
    ) {
        const result = await suppliersService.listSuppliersForSync({
            updatedSince: query.updatedSince,
        });
        return { data: result.items };
    }

    @Get(':id')
    @RequirePermission('suppliers', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const supplier = await suppliersService.getSupplier(params.id);
        return { data: supplier };
    }

    @Post()
    @RequirePermission('suppliers')
    @HttpCode(201)
    async create(@Body(new ZodValidationPipe(createSupplierSchema)) body: CreateSupplierInput) {
        const supplier = await suppliersService.createSupplier(body);
        return { data: supplier };
    }

    @Patch(':id')
    @RequirePermission('suppliers')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateSupplierSchema)) body: UpdateSupplierInput,
    ) {
        const supplier = await suppliersService.updateSupplier(params.id, body);
        return { data: supplier };
    }

    @Delete(':id')
    @RequirePermission('suppliers')
    async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const supplier = await suppliersService.deleteSupplier(params.id);
        return { data: supplier };
    }
}
