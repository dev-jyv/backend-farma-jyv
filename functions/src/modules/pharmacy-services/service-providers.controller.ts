import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createServiceProviderSchema,
    idParamSchema,
    listServiceProvidersQuerySchema,
    syncServiceProvidersQuerySchema,
    updateServiceProviderSchema,
} from '../../schemas';
import * as serviceProvidersService from '../../services/service-providers.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListQuery = z.infer<typeof listServiceProvidersQuerySchema>;
type SyncQuery = z.infer<typeof syncServiceProvidersQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateInput = z.infer<typeof createServiceProviderSchema>;
type UpdateInput = z.infer<typeof updateServiceProviderSchema>;

/**
 * Padrón de quienes realizan los servicios ("doctores"). **No son usuarios del
 * sistema**: viven aquí y no en `users` justamente para poder acreditarles
 * comisiones sin darles acceso. Comparten el área `pharmacyServices` con el
 * catálogo de servicios porque se administran juntos.
 */
@Controller('service-providers')
export class ServiceProvidersController {
    @Get()
    @RequirePermission('pharmacyServices', 'read')
    async list(@Query(new ZodValidationPipe(listServiceProvidersQuerySchema)) query: ListQuery) {
        const result = await serviceProvidersService.listServiceProviders({
            activeOnly: query.activeOnly !== 'false',
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Padrón completo sin paginar, para el pull local-first del POS (SQLite). */
    @Get('sync')
    @RequirePermission('pharmacyServices', 'read')
    async sync(@Query(new ZodValidationPipe(syncServiceProvidersQuerySchema)) query: SyncQuery) {
        const result = await serviceProvidersService.listServiceProvidersForSync({
            updatedSince: query.updatedSince,
        });
        return { data: result.items };
    }

    @Get(':id')
    @RequirePermission('pharmacyServices', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const provider = await serviceProvidersService.getServiceProvider(params.id);
        return { data: provider };
    }

    @Post()
    @RequirePermission('pharmacyServices')
    @HttpCode(201)
    async create(@Body(new ZodValidationPipe(createServiceProviderSchema)) body: CreateInput) {
        const provider = await serviceProvidersService.createServiceProvider(body);
        return { data: provider };
    }

    @Patch(':id')
    @RequirePermission('pharmacyServices')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateServiceProviderSchema)) body: UpdateInput,
    ) {
        const provider = await serviceProvidersService.updateServiceProvider(params.id, body);
        return { data: provider };
    }

    @Delete(':id')
    @RequirePermission('pharmacyServices')
    async remove(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const provider = await serviceProvidersService.deleteServiceProvider(params.id);
        return { data: provider };
    }
}
