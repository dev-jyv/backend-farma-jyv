import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { reportExportQuerySchema } from '../../schemas';
import { exportReport, previewReport } from '../../services/report-export/export-report';
import { REPORT_KEYS } from '../../services/report-export/registry';
import { AuthUser } from '../../types';
import { sendFile } from '../../common/send-file';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequireAnyPermission } from '../identity/decorators/require-permission.decorator';

type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

const reportKeySchema = z.enum(REPORT_KEYS);

const nameOf = (user: AuthUser): string => user.displayName || user.email;

/**
 * Descarga genérica de reportes en `api` (`pdf`, `xlsx`, `csv`, y `json` como vista
 * previa). Las rutas `*.pdf` del módulo viven en `ReportPdfExportsController`
 * (función `reportsPdf`, SPEC 38), que `ReportsModule` registra **antes** que este
 * controller para que `:report` no las capture. Escribe la respuesta con `@Res()` a
 * propósito: el interceptor de la app envuelve todo en `{ data }` y un archivo
 * envuelto en JSON no lo abre nadie.
 */
@Controller('reports/exports')
export class ReportExportsController {
    /**
     * Descarga genérica: `GET /reports/exports/:report?format=pdf|xlsx|csv|json`. Va
     * después de las rutas `*.pdf` para que no las capture; esas siguen igual para no
     * romper al front.
     *
     * Entra con `dashboard:read` **o** `reportDownloads:read` (contador, SPEC 45); qué
     * reportes abre cada área lo decide `exportReport` (`assertCanExportReport`), y
     * cada reporte puede añadir su propia restricción (el libro de controlados exige
     * administrador o gerente).
     *
     * `format=json` no baja archivo: devuelve `{ data: { columns, rows, totals,
     * truncated, rowCount } }` para la vista previa, con la misma autorización.
     */
    @Get(':report')
    @RequireAnyPermission(
        { area: 'dashboard', level: 'read' },
        { area: 'reportDownloads', level: 'read' },
    )
    async download(
        @Param('report', new ZodValidationPipe(reportKeySchema)) report: string,
        @Query(new ZodValidationPipe(reportExportQuerySchema)) query: ReportExportQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        const { format, ...filters } = query;
        const access = { roleSlug: user.role.slug, permissions: user.permissions };
        if (format === 'json') {
            const data = await previewReport({ report, query: filters, ...access });
            res.status(200).json({ data });
            return;
        }
        sendFile(res, await exportReport({
            report,
            format,
            query: filters,
            generatedBy: nameOf(user),
            ...access,
        }));
    }
}
