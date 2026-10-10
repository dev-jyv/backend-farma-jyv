import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createPharmacyServiceSchema,
    idParamSchema,
    listPharmacyServicesQuerySchema,
    syncPharmacyServicesQuerySchema,
    updatePharmacyServiceSchema,
} from '../../schemas';
import * as pharmacyServicesService from '../../services/pharmacy-services.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListQuery = z.infer<typeof listPharmacyServicesQuerySchema>;
type SyncQuery = z.infer<typeof syncPharmacyServicesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateInput = z.infer<typeof createPharmacyServiceSchema>;
type UpdateInput = z.infer<typeof updatePharmacyServiceSchema>;

/**
 * Catálogo de servicios que la farmacia cobra en la misma venta que la
 * mercancía. Lectura hasta el mostrador (`read`, que tienen cajero y gerente);
 * escritura solo administrador —el precio y la comisión deciden cuánto se le
 * paga al doctor.
 */
@Controller('pharmacy-services')
export class PharmacyServicesController {
    @Get()
    @RequirePermission('pharmacyServices', 'read')
    async list(@Query(new ZodValidationPipe(listPharmacyServicesQuerySchema)) query: ListQuery) {
        const result = await pharmacyServicesService.listPharmacyServices({
            activeOnly: query.activeOnly !== 'false',
            serviceType: query.serviceType,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Catálogo completo sin paginar, para el pull local-first del POS (SQLite). */
    @Get('sync')
    @RequirePermission('pharmacyServices', 'read')
    async sync(@Query(new ZodValidationPipe(syncPharmacyServicesQuerySchema)) query: SyncQuery) {
        const result = await pharmacyServicesService.listPharmacyServicesForSync({
            updatedSince: query.updatedSince,
        });
        return { data: result.items };
    }

    @Get(':id')
    @RequirePermission('pharmacyServices', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const service = await pharmacyServicesService.getPharmacyService(params.id);
        return { data: service };
    }

    @Post()
    @RequirePermission('pharmacyServices')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createPharmacyServiceSchema)) body: CreateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const service = await pharmacyServicesService.createPharmacyService(body, {
            userId: user.uid,
        });
        return { data: service };
    }

    @Patch(':id')
    @RequirePermission('pharmacyServices')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updatePharmacyServiceSchema)) body: UpdateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const service = await pharmacyServicesService.updatePharmacyService(params.id, body, {
            userId: user.uid,
        });
        return { data: service };
    }

    @Delete(':id')
    @RequirePermission('pharmacyServices')
    async remove(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const service = await pharmacyServicesService.deletePharmacyService(params.id, {
            userId: user.uid,
        });
        return { data: service };
    }
}
