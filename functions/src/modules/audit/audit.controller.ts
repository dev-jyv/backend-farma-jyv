import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { listAuditLogsQuerySchema } from '../../schemas';
import * as auditService from '../../services/audit.service';
import { AuditAction } from '../../types';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

/**
 * Consulta de la bitácora. Va bajo el área de permiso `users` (igual que roles):
 * quien administra accesos es quien revisa la bitácora, y no se creó un área nueva
 * para no invalidar los roles existentes.
 */
@Controller('audit-logs')
export class AuditController {
    @Get()
    @RequirePermission('users', 'read')
    async list(
        @Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery,
    ) {
        const result = await auditService.listAuditLogs({
            action: query.action as AuditAction | undefined,
            entity: query.entity,
            entityId: query.entityId,
            userId: query.userId,
            from: query.from,
            to: query.to,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }
}
