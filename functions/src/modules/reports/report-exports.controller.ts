import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { reportExportQuerySchema } from '../../schemas';
import { exportReport } from '../../services/report-export/export-report';
import { REPORT_KEYS } from '../../services/report-export/registry';
import { AuthUser } from '../../types';
import { sendFile } from '../../common/send-file';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

const reportKeySchema = z.enum(REPORT_KEYS);

const nameOf = (user: AuthUser): string => user.displayName || user.email;

/**
 * Descarga genérica de reportes en `api` (`pdf`, `xlsx`, `csv`). Las rutas `*.pdf`
 * del módulo viven en `ReportPdfExportsController` (función `reportsPdf`, SPEC 38),
 * que `ReportsModule` registra **antes** que este controller para que `:report`
 * no las capture. Escribe la respuesta con `@Res()` a propósito: el interceptor de
 * la app envuelve todo en `{ data }` y un archivo envuelto en JSON no lo abre nadie.
 */
@Controller('reports/exports')
export class ReportExportsController {
    /**
     * Descarga genérica: `GET /reports/exports/:report?format=pdf|xlsx|csv`. Va después de
     * las rutas `*.pdf` para que no las capture; esas siguen igual para no romper al front.
     * Cada reporte puede añadir su propia restricción (el libro de controlados exige
     * administrador o gerente) además de `dashboard:read`.
     */
    @Get(':report')
    @RequirePermission('dashboard', 'read')
    async download(
        @Param('report', new ZodValidationPipe(reportKeySchema)) report: string,
        @Query(new ZodValidationPipe(reportExportQuerySchema)) query: ReportExportQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        const { format, ...filters } = query;
        sendFile(res, await exportReport({
            report,
            format,
            query: filters,
            generatedBy: nameOf(user),
            roleSlug: user.role.slug,
        }));
    }
}
