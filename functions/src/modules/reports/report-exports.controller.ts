import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import {
    dailySalesExportQuerySchema,
    monthlyExportQuerySchema,
    reportExportQuerySchema,
} from '../../schemas';
import * as moduleReports from '../../services/module-reports.service';
import { exportReport } from '../../services/report-export/export-report';
import { REPORT_KEYS } from '../../services/report-export/registry';
import { AuthUser } from '../../types';
import { sendFile } from '../../common/send-file';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

type DailyQuery = z.infer<typeof dailySalesExportQuerySchema>;
type MonthlyQuery = z.infer<typeof monthlyExportQuerySchema>;
type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

const reportKeySchema = z.enum(REPORT_KEYS);

const sendPdf = (res: Response, file: { pdf: Buffer; fileName: string }): void =>
    sendFile(res, { body: file.pdf, contentType: 'application/pdf', fileName: file.fileName });

const nameOf = (user: AuthUser): string => user.displayName || user.email;

/**
 * Descargas PDF del módulo de Reportes. Bajo `dashboard:read` (solo
 * administrador): incluyen quién cobró cada venta y, en el financiero, cifras de
 * todo el negocio. `dashboard` es el área paraguas de la analítica del negocio
 * (igual que `business-summary` y el asistente): quien la recibe en un rol
 * personalizado lee estos datos aunque no tenga `expenses`/`accounting` aparte;
 * hoy solo el administrador la tiene. Escriben la respuesta con `@Res()` a propósito: el
 * interceptor de la app envuelve todo en `{ data }` y un PDF envuelto en JSON no
 * lo abre nadie.
 */
@Controller('reports/exports')
export class ReportExportsController {
    @Get('sales-daily.pdf')
    @RequirePermission('dashboard', 'read')
    async salesDaily(
        @Query(new ZodValidationPipe(dailySalesExportQuerySchema)) query: DailyQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        sendPdf(res, await moduleReports.buildSalesPdf({
            scope: query.scope,
            kind: 'daily',
            period: query.date,
            generatedBy: nameOf(user),
        }));
    }

    @Get('sales-monthly.pdf')
    @RequirePermission('dashboard', 'read')
    async salesMonthly(
        @Query(new ZodValidationPipe(monthlyExportQuerySchema)) query: MonthlyQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        sendPdf(res, await moduleReports.buildSalesPdf({
            scope: query.scope,
            kind: 'monthly',
            period: query.month,
            generatedBy: nameOf(user),
        }));
    }

    @Get('inventory.pdf')
    @RequirePermission('dashboard', 'read')
    async inventory(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildInventoryPdf({ generatedBy: nameOf(user) }));
    }

    @Get('low-stock.pdf')
    @RequirePermission('dashboard', 'read')
    async lowStock(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildLowStockPdf({ generatedBy: nameOf(user) }));
    }

    @Get('expiring.pdf')
    @RequirePermission('dashboard', 'read')
    async expiring(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildExpiryPdf({ generatedBy: nameOf(user) }));
    }

    @Get('no-cost.pdf')
    @RequirePermission('dashboard', 'read')
    async noCost(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildNoCostPdf({ generatedBy: nameOf(user) }));
    }

    @Get('expenses-monthly.pdf')
    @RequirePermission('dashboard', 'read')
    async expensesMonthly(
        @Query(new ZodValidationPipe(monthlyExportQuerySchema)) query: MonthlyQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        sendPdf(res, await moduleReports.buildExpensesPdf({
            month: query.month,
            generatedBy: nameOf(user),
        }));
    }

    @Get('invoices.pdf')
    @RequirePermission('dashboard', 'read')
    async invoices(
        @Query(new ZodValidationPipe(monthlyExportQuerySchema)) query: MonthlyQuery,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ) {
        sendPdf(res, await moduleReports.buildInvoicesPdf({
            month: query.month,
            generatedBy: nameOf(user),
        }));
    }

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
