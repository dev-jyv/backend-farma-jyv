import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createPromotionSchema,
    idParamSchema,
    listPromotionsQuerySchema,
    syncPromotionsQuerySchema,
    updatePromotionSchema,
} from '../../schemas';
import * as promotionsService from '../../services/promotions.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListQuery = z.infer<typeof listPromotionsQuerySchema>;
type SyncQuery = z.infer<typeof syncPromotionsQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;
type CreateInput = z.infer<typeof createPromotionSchema>;
type UpdateInput = z.infer<typeof updatePromotionSchema>;

/**
 * Promociones por cantidad. Lectura hasta el mostrador (el POS las baja con
 * `/sync`); escritura de gerencia y administración —deciden precio.
 */
@Controller('promotions')
export class PromotionsController {
    @Get()
    @RequirePermission('promotions', 'read')
    async list(@Query(new ZodValidationPipe(listPromotionsQuerySchema)) query: ListQuery) {
        const result = await promotionsService.listPromotions({
            activeOnly: query.activeOnly !== 'false',
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Todas las promociones sin paginar, para el pull local-first del POS. */
    @Get('sync')
    @RequirePermission('promotions', 'read')
    async sync(@Query(new ZodValidationPipe(syncPromotionsQuerySchema)) query: SyncQuery) {
        const result = await promotionsService.listPromotionsForSync({
            updatedSince: query.updatedSince,
        });
        return { data: result.items };
    }

    @Get(':id')
    @RequirePermission('promotions', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const promotion = await promotionsService.getPromotion(params.id);
        return { data: promotion };
    }

    @Post()
    @RequirePermission('promotions')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createPromotionSchema)) body: CreateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const promotion = await promotionsService.createPromotion(body, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: promotion };
    }

    @Patch(':id')
    @RequirePermission('promotions')
    async update(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updatePromotionSchema)) body: UpdateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const promotion = await promotionsService.updatePromotion(params.id, body, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: promotion };
    }

    @Delete(':id')
    @RequirePermission('promotions')
    async remove(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const promotion = await promotionsService.deletePromotion(params.id, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: promotion };
    }
}
