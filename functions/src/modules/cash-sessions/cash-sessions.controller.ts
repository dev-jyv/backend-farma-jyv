import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    closeCashSessionSchema,
    createCashMovementSchema,
    idParamSchema,
    openCashSessionSchema,
    receiptQuerySchema,
} from '../../schemas';
import * as cashSessionsService from '../../services/cash-sessions.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;
type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;
type CreateCashMovementInput = z.infer<typeof createCashMovementSchema>;
type IdParam = z.infer<typeof idParamSchema>;
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;

@Controller('cash-sessions')
export class CashSessionsController {
    @Get('current')
    @RequirePermission('sales', 'read')
    async current(@CurrentUser() user: AuthUser) {
        const session = await cashSessionsService.getCurrentSession(user.uid);
        return { data: session };
    }

    @Get(':id/summary')
    @RequirePermission('sales', 'read')
    async summary(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await cashSessionsService.getSessionSummary(
            params.id,
            user.uid,
            user.role.slug,
        );
        return { data: result };
    }

    /**
     * Lectura X (vista previa): foto del turno sin cerrarlo y sin dejar registro.
     * Para dejar constancia impresa se usa `POST :id/x-report`.
     */
    @Get(':id/x-report')
    @RequirePermission('sales', 'read')
    async previewXReport(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(receiptQuerySchema)) query: ReceiptQuery,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await cashSessionsService.buildXReport(
            params.id,
            user.uid,
            user.role.slug,
            { width: query.width },
        );
        return { data: result };
    }

    /** Lectura X registrada: deja renglón en `cashReadings` con folio `X-000001`. */
    @Post(':id/x-report')
    @RequirePermission('sales')
    @HttpCode(201)
    async recordXReport(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Query(new ZodValidationPipe(receiptQuerySchema)) query: ReceiptQuery,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await cashSessionsService.buildXReport(
            params.id,
            user.uid,
            user.role.slug,
            { persist: true, width: query.width },
        );
        return { data: result };
    }

    @Get(':id/x-readings')
    @RequirePermission('sales', 'read')
    async listXReadings(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const readings = await cashSessionsService.listXReadings(
            params.id,
            user.uid,
            user.role.slug,
        );
        return { data: readings };
    }

    @Get(':id/movements')
    @RequirePermission('sales', 'read')
    async listMovements(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @CurrentUser() user: AuthUser,
    ) {
        const movements = await cashSessionsService.listMovements(
            params.id,
            user.uid,
            user.role.slug,
        );
        return { data: movements };
    }

    @Post()
    @RequirePermission('sales')
    async open(
        @Body(new ZodValidationPipe(openCashSessionSchema)) body: OpenCashSessionInput,
        @CurrentUser() user: AuthUser,
    ) {
        const session = await cashSessionsService.openSession(user.uid, body.openingAmount);
        return { data: session };
    }

    @Post(':id/movements')
    @RequirePermission('sales')
    async addMovement(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(createCashMovementSchema)) body: CreateCashMovementInput,
        @CurrentUser() user: AuthUser,
    ) {
        const movement = await cashSessionsService.addMovement(
            params.id,
            user.uid,
            user.role.slug,
            body,
        );
        return { data: movement };
    }

    @Post(':id/close')
    @RequirePermission('sales')
    async close(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(closeCashSessionSchema)) body: CloseCashSessionInput,
        @Query(new ZodValidationPipe(receiptQuerySchema)) query: ReceiptQuery,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await cashSessionsService.closeSession(
            params.id,
            user.uid,
            user.role.slug,
            body.countedCashAmount,
            { width: query.width },
        );
        return { data: result };
    }
}
