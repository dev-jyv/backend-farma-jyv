import {
    Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    createPromotionSchema,
    expiringSuggestionsQuerySchema,
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
type ExpiringQuery = z.infer<typeof expiringSuggestionsQuerySchema>;
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

    /**
     * Lotes por caducar con una promo sugerida. Declarada **antes** de `:id`:
     * Express resuelve en orden y `suggestions` se tomaría como id.
     */
    @Get('suggestions/expiring')
    @RequirePermission('promotions', 'read')
    async expiringSuggestions(
        @Query(new ZodValidationPipe(expiringSuggestionsQuerySchema)) query: ExpiringQuery,
    ) {
        const suggestions = await promotionsService.listExpiringPromotionSuggestions({
            days: query.days,
        });
        return { data: suggestions };
    }

    @Get(':id/performance')
    @RequirePermission('promotions', 'read')
    async performance(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const performance = await promotionsService.getPromotionPerformance(params.id);
        return { data: performance };
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

    /**
     * Cambiar regla o productos = crear otra y dar de baja esta (son
     * inmutables). Si la nueva no valida, la vieja no se toca.
     */
    @Post(':id/replace')
    @RequirePermission('promotions')
    @HttpCode(201)
    async replace(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(createPromotionSchema)) body: CreateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await promotionsService.replacePromotion(params.id, body, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: result };
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
