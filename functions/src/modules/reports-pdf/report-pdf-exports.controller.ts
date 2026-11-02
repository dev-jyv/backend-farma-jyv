import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { dailySalesExportQuerySchema, monthlyExportQuerySchema } from '../../schemas';
import * as moduleReports from '../../services/module-reports.service';
import { AuthUser } from '../../types';
import { sendFile } from '../../common/send-file';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

type DailyQuery = z.infer<typeof dailySalesExportQuerySchema>;
type MonthlyQuery = z.infer<typeof monthlyExportQuerySchema>;

const sendPdf = (res: Response, file: { pdf: Buffer; fileName: string }): void =>
    sendFile(res, { body: file.pdf, contentType: 'application/pdf', fileName: file.fileName });

export const generatedByOf = (user: AuthUser): string => user.displayName || user.email;

/**
 * Descargas PDF del módulo de Reportes (`/reports/exports/*.pdf`). Lanzan Chromium,
 * así que viven en la función `reportsPdf` (1 GiB, SPEC 38). Mientras el panel
 * viejo siga en producción la misma clase también se registra en `api`, **antes**
 * que `ReportExportsController`: su `:report` capturaría `sales-daily.pdf`.
 *
 * Bajo `dashboard:read` (solo administrador): incluyen quién cobró cada venta y,
 * en el financiero, cifras de todo el negocio. `dashboard` es el área paraguas de
 * la analítica del negocio (igual que `business-summary` y el asistente): quien la
 * recibe en un rol personalizado lee estos datos aunque no tenga
 * `expenses`/`accounting` aparte. Escriben la respuesta con `@Res()` a propósito: el
 * interceptor de la app envuelve todo en `{ data }` y un PDF envuelto en JSON no
 * lo abre nadie.
 */
@Controller('reports/exports')
export class ReportPdfExportsController {
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
            generatedBy: generatedByOf(user),
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
            generatedBy: generatedByOf(user),
        }));
    }

    @Get('inventory.pdf')
    @RequirePermission('dashboard', 'read')
    async inventory(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildInventoryPdf({ generatedBy: generatedByOf(user) }));
    }

    @Get('low-stock.pdf')
    @RequirePermission('dashboard', 'read')
    async lowStock(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildLowStockPdf({ generatedBy: generatedByOf(user) }));
    }

    @Get('expiring.pdf')
    @RequirePermission('dashboard', 'read')
    async expiring(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildExpiryPdf({ generatedBy: generatedByOf(user) }));
    }

    @Get('no-cost.pdf')
    @RequirePermission('dashboard', 'read')
    async noCost(@CurrentUser() user: AuthUser, @Res() res: Response) {
        sendPdf(res, await moduleReports.buildNoCostPdf({ generatedBy: generatedByOf(user) }));
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
            generatedBy: generatedByOf(user),
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
            generatedBy: generatedByOf(user),
        }));
    }
}
