import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { reportPdfExportQuerySchema } from '../../schemas';
import { exportReport } from '../../services/report-export/export-report';
import { REPORT_KEYS } from '../../services/report-export/registry';
import { AuthUser } from '../../types';
import { sendFile } from '../../common/send-file';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequireAnyPermission } from '../identity/decorators/require-permission.decorator';
import { generatedByOf } from './report-pdf-exports.controller';

type ReportPdfExportQuery = z.infer<typeof reportPdfExportQuerySchema>;

const reportKeySchema = z.enum(REPORT_KEYS);

/**
 * `GET /reports/exports/:report?format=pdf` en la función `reportsPdf`. Solo PDF:
 * XLSX y CSV no usan Chromium y siguen en `api` (SPEC 38), así que aquí un
 * `format` distinto es un 400 en vez de servirse desde la función cara. Mismas
 * reglas que la ruta de `api`: `dashboard:read` o `reportDownloads:read` (contador,
 * SPEC 45), y dentro de `exportReport` qué reportes abre cada área y el `authorize`
 * de cada reporte (el libro de controlados exige administrador o gerente).
 *
 * Solo se registra en `reportsPdf`, y después de `ReportPdfExportsController`
 * para que `:report` no capture las rutas `*.pdf`.
 */
@Controller('reports/exports')
export class ReportPdfDownloadController {
    @Get(':report')
    @RequireAnyPermission(
        { area: 'dashboard', level: 'read' },
        { area: 'reportDownloads', level: 'read' },
    )
    async download(
        @Param('report', new ZodValidationPipe(reportKeySchema)) report: string,
        @Query(new ZodValidationPipe(reportPdfExportQuerySchema)) query: ReportPdfExportQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        const { format, ...filters } = query;
        sendFile(res, await exportReport({
            report,
            format,
            query: filters,
            generatedBy: generatedByOf(user),
            roleSlug: user.role.slug,
            permissions: user.permissions,
        }));
    }
}
