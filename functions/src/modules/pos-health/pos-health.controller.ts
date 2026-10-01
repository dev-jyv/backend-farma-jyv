import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
    createPosCommandSchema,
    posCommandIdParamSchema,
    posCommandResultSchema,
    posDeviceParamSchema,
    posDiagnosticsSchema,
} from '../../schemas';
import * as posHealthService from '../../services/pos-health.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type DiagnosticsInput = z.infer<typeof posDiagnosticsSchema>;
type DeviceParam = z.infer<typeof posDeviceParamSchema>;
type CommandIdParam = z.infer<typeof posCommandIdParamSchema>;
type CreateCommandInput = z.infer<typeof createPosCommandSchema>;
type CommandResultInput = z.infer<typeof posCommandResultSchema>;

/**
 * Salud de cajas. Dos lados con permisos distintos en el mismo controller:
 *
 * - **La caja** (`pos:write`, el que ya tiene el cajero): sube su diagnóstico,
 *   recoge sus comandos pendientes y reporta cómo le fue con cada uno. No se
 *   creó un permiso aparte para esto porque cualquier caja que puede vender
 *   tiene que poder reportar que no está pudiendo subir lo vendido.
 * - **El admin** (`posHealth`): lee el diagnóstico de todas las cajas y encola
 *   comandos. El cajero no lo tiene: ver las cajas de los demás y operarlas a
 *   distancia es supervisión.
 */
@Controller('pos')
export class PosHealthController {
    /** 200 y no el 201 por omisión de `@Post`: sobrescribe el snapshot, no crea un recurso. */
    @Post('diagnostics')
    @RequirePermission('pos')
    @HttpCode(200)
    async report(
        @Body(new ZodValidationPipe(posDiagnosticsSchema)) body: DiagnosticsInput,
        @CurrentUser() user: AuthUser,
    ) {
        const result = await posHealthService.reportDiagnostics(body, user.uid);
        return { data: result };
    }

    @Get('diagnostics')
    @RequirePermission('posHealth', 'read')
    async list() {
        const snapshots = await posHealthService.listDiagnostics();
        return { data: snapshots };
    }

    @Get('diagnostics/:deviceId')
    @RequirePermission('posHealth', 'read')
    async get(@Param(new ZodValidationPipe(posDeviceParamSchema)) params: DeviceParam) {
        const result = await posHealthService.getDeviceDiagnostics(params.deviceId);
        return { data: result };
    }

    @Post('commands')
    @RequirePermission('posHealth')
    @HttpCode(201)
    async createCommand(
        @Body(new ZodValidationPipe(createPosCommandSchema)) body: CreateCommandInput,
        @CurrentUser() user: AuthUser,
    ) {
        const command = await posHealthService.createCommand(body, {
            userId: user.uid,
            roleSlug: user.role.slug,
        });
        return { data: command };
    }

    @Post('commands/:id/result')
    @RequirePermission('pos')
    @HttpCode(200)
    async reportResult(
        @Param(new ZodValidationPipe(posCommandIdParamSchema)) params: CommandIdParam,
        @Body(new ZodValidationPipe(posCommandResultSchema)) body: CommandResultInput,
        @CurrentUser() user: AuthUser,
    ) {
        const command = await posHealthService.completeCommand(params.id, body, user.uid);
        return { data: command };
    }
}
