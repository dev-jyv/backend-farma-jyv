import {
    Body, Controller, Delete, Get, HttpCode, Param, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
    couponCodeParamSchema,
    createCouponSchema,
    listCouponsQuerySchema,
    syncCouponsQuerySchema,
} from '../../schemas';
import * as couponsService from '../../services/coupons.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListQuery = z.infer<typeof listCouponsQuerySchema>;
type SyncQuery = z.infer<typeof syncCouponsQuerySchema>;
type CodeParam = z.infer<typeof couponCodeParamSchema>;
type CreateInput = z.infer<typeof createCouponSchema>;

/**
 * Cupones de descuento (SPEC 47), bajo el área `promotions`: lectura hasta el
 * mostrador (el POS los sincroniza), alta y baja de gerencia y administración.
 * No hay edición: alcance, descuento y productos son inmutables.
 */
@Controller('coupons')
export class CouponsController {
    @Get()
    @RequirePermission('promotions', 'read')
    async list(@Query(new ZodValidationPipe(listCouponsQuerySchema)) query: ListQuery) {
        const result = await couponsService.listCoupons({
            isActive: query.isActive === undefined ? undefined : query.isActive === 'true',
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /**
     * Todos los cupones sin paginar (inactivos incluidos), para el pull del POS.
     * Declarada **antes** de `:code`: Express resuelve en orden.
     */
    @Get('sync')
    @RequirePermission('promotions', 'read')
    async sync(@Query(new ZodValidationPipe(syncCouponsQuerySchema)) query: SyncQuery) {
        const result = await couponsService.listCouponsForSync({
            updatedSince: query.updatedSince,
        });
        return { data: result.items, meta: { serverTime: result.serverTime } };
    }

    @Get(':code')
    @RequirePermission('promotions', 'read')
    async get(@Param(new ZodValidationPipe(couponCodeParamSchema)) params: CodeParam) {
        return { data: await couponsService.getCoupon(params.code) };
    }

    @Post()
    @RequirePermission('promotions')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createCouponSchema)) body: CreateInput,
        @CurrentUser() user: AuthUser,
    ) {
        const coupon = await couponsService.createCoupon(body, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: coupon };
    }

    /** Baja lógica: el código queda tomado para siempre. */
    @Delete(':code')
    @RequirePermission('promotions')
    async remove(
        @Param(new ZodValidationPipe(couponCodeParamSchema)) params: CodeParam,
        @CurrentUser() user: AuthUser,
    ) {
        const coupon = await couponsService.deactivateCoupon(params.code, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: coupon };
    }
}
