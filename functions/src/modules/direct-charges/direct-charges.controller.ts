import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    createDirectChargeSchema,
    createOnlineDirectChargeSchema,
    idParamSchema,
    idempotencyKeySchema,
    listDirectChargesQuerySchema,
} from '../../schemas';
import * as directChargesService from '../../services/direct-charges.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type CreateDirectChargeInput = z.infer<typeof createDirectChargeSchema>;
type CreateOnlineDirectChargeInput = z.infer<typeof createOnlineDirectChargeSchema>;
type ListDirectChargesQuery = z.infer<typeof listDirectChargesQuerySchema>;
type IdParam = z.infer<typeof idParamSchema>;

/**
 * Cobros con terminal que no corresponden a una venta. Colección aparte
 * (`directCharges`): no entran a `sales`, ni al inventario, ni al corte de caja.
 */
@Controller('direct-charges')
export class DirectChargesController {
    @Post()
    @RequirePermission('directCharges')
    @HttpCode(201)
    async create(
        @Body(new ZodValidationPipe(createDirectChargeSchema)) body: CreateDirectChargeInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        // La llave puede llegar en el body o en el header estándar `Idempotency-Key`.
        const rawKey = body.idempotencyKey ?? idempotencyHeader;
        const idempotencyKey = rawKey
            ? new ZodValidationPipe(idempotencyKeySchema).transform(rawKey)
            : undefined;

        const charge = await directChargesService.createDirectCharge({
            deviceId: body.deviceId,
            amount: body.amount,
            concept: body.concept,
            idempotencyKey,
            cashierId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: charge };
    }

    /** Cobro en línea: devuelve el link de pago (Checkout Pro) en `online.initPoint`. */
    @Post('online')
    @RequirePermission('directCharges')
    @HttpCode(201)
    async createOnline(
        @Body(new ZodValidationPipe(createOnlineDirectChargeSchema))
            body: CreateOnlineDirectChargeInput,
        @CurrentUser() user: AuthUser,
        @Headers('idempotency-key') idempotencyHeader?: string,
    ) {
        const rawKey = body.idempotencyKey ?? idempotencyHeader;
        const idempotencyKey = rawKey
            ? new ZodValidationPipe(idempotencyKeySchema).transform(rawKey)
            : undefined;

        const charge = await directChargesService.createOnlineDirectCharge({
            amount: body.amount,
            concept: body.concept,
            idempotencyKey,
            cashierId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: charge };
    }

    @Get()
    @RequirePermission('directCharges', 'read')
    async list(
        @Query(new ZodValidationPipe(listDirectChargesQuerySchema)) query: ListDirectChargesQuery,
    ) {
        const result = await directChargesService.listDirectCharges({
            from: query.from,
            to: query.to,
            channel: query.channel,
            status: query.status,
            search: query.search,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Estado actual: consulta la terminal si el cobro sigue pendiente. */
    @Get(':id')
    @RequirePermission('directCharges', 'read')
    async get(@Param(new ZodValidationPipe(idParamSchema)) params: IdParam) {
        const charge = await directChargesService.syncDirectCharge(params.id);
        return { data: charge };
    }

    @Post(':id/cancel')
    @RequirePermission('directCharges')
    async cancel(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const charge = await directChargesService.cancelDirectCharge(params.id, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: charge };
    }
}
