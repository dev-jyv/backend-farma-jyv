import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    closeCashSessionSchema,
    createCashBoxMovementSchema,
    createCashMovementSchema,
    idParamSchema,
    listCashMovementsQuerySchema,
    listCashSessionsQuerySchema,
    openCashSessionSchema,
    receiptQuerySchema,
    reviewAdjustmentSchema,
    updateExpenseSchema,
} from '../../schemas';
import * as cashSessionsService from '../../services/cash-sessions.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;
type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;
type CreateCashMovementInput = z.infer<typeof createCashMovementSchema>;
type CreateCashBoxMovementInput = z.infer<typeof createCashBoxMovementSchema>;
type ListCashSessionsQuery = z.infer<typeof listCashSessionsQuerySchema>;
type ListCashMovementsQuery = z.infer<typeof listCashMovementsQuerySchema>;
type ReviewAdjustmentInput = z.infer<typeof reviewAdjustmentSchema>;
type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
type IdParam = z.infer<typeof idParamSchema>;
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;

@Controller('cash-sessions')
export class CashSessionsController {
    /** Auditoría (solo admin): todas las cajas, no solo la propia. */
    @Get()
    @RequirePermission('cashSessions', 'read')
    async list(
        @Query(new ZodValidationPipe(listCashSessionsQuerySchema)) query: ListCashSessionsQuery,
    ) {
        const result = await cashSessionsService.listCashSessions({
            from: query.from,
            to: query.to,
            openedBy: query.openedBy,
            adjustmentStatus: query.adjustmentStatus,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /** Auditoría (solo admin): depósitos/retiros/gastos de todas las cajas. */
    @Get('movements')
    @RequirePermission('expenses', 'read')
    async listAllMovements(
        @Query(new ZodValidationPipe(listCashMovementsQuerySchema)) query: ListCashMovementsQuery,
    ) {
        const result = await cashSessionsService.listAllMovements({
            from: query.from,
            to: query.to,
            type: query.type,
            category: query.category,
            cashSessionId: query.cashSessionId,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    /**
     * Caja de la farmacia (solo admin): entrada o salida de efectivo que puede ir
     * sin turno abierto. Declarada antes que las rutas `:id` a propósito, o Nest
     * la resolvería como `POST /cash-sessions/:id` con `id = 'movements'`.
     */
    @Post('movements')
    @HttpCode(201)
    @RequirePermission('cashSessions', 'write')
    async addCashBoxMovement(
        @Body(new ZodValidationPipe(createCashBoxMovementSchema)) body: CreateCashBoxMovementInput,
        @CurrentUser() user: AuthUser,
    ) {
        const movement = await cashSessionsService.addCashBoxMovement(
            user.uid,
            user.role.slug,
            body,
        );
        return { data: movement };
    }

    /**
     * Corrige un gasto del turno abierto. `PATCH` y no `POST`: es una enmienda
     * sobre un movimiento existente, no un movimiento nuevo — duplicarlo
     * descuadraría el efectivo esperado del corte.
     */
    @Patch('movements/:id')
    @RequirePermission('pos', 'write')
    async updateExpense(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateExpenseSchema)) body: UpdateExpenseInput,
        @CurrentUser() user: AuthUser,
    ) {
        const movement = await cashSessionsService.updateExpense(
            params.id,
            user.uid,
            user.role.slug,
            body,
        );
        return { data: movement };
    }

    @Post(':id/adjustment/review')
    @RequirePermission('cashSessions', 'write')
    async reviewAdjustment(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(reviewAdjustmentSchema)) body: ReviewAdjustmentInput,
        @CurrentUser() user: AuthUser,
    ) {
        const session = await cashSessionsService.reviewAdjustment(
            params.id,
            user.uid,
            body.decision,
            body.note,
        );
        return { data: session };
    }

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
    @RequirePermission('pos')
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
    @RequirePermission('pos')
    async open(
        @Body(new ZodValidationPipe(openCashSessionSchema)) body: OpenCashSessionInput,
        @CurrentUser() user: AuthUser,
    ) {
        const session = await cashSessionsService.openSession(user.uid, body.openingAmount);
        return { data: session };
    }

    @Post(':id/movements')
    @RequirePermission('pos')
    async addMovement(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(createCashMovementSchema)) body: CreateCashMovementInput,
        @CurrentUser() user: AuthUser,
    ) {
        const movement = await cashSessionsService.addMovement(
            params.id,
            user.uid,
            user.role.slug,
            // La etiqueta la pone el servidor, no el cliente: es quién firma el
            // gasto en la auditoría, así que aceptarla del cuerpo permitiría
            // registrarlo a nombre de otro.
            { ...body, createdByLabel: user.displayName || user.email },
        );
        return { data: movement };
    }

    @Post(':id/close')
    @RequirePermission('pos')
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
            { width: query.width, autoClosedByExpiry: body.autoClosedByExpiry },
        );
        return { data: result };
    }
}
