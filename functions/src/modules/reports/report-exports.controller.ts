import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { dailySalesExportQuerySchema, monthlyExportQuerySchema } from '../../schemas';
import * as moduleReports from '../../services/module-reports.service';
import { AuthUser } from '../../types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

type DailyQuery = z.infer<typeof dailySalesExportQuerySchema>;
type MonthlyQuery = z.infer<typeof monthlyExportQuerySchema>;

const sendPdf = (res: Response, file: { pdf: Buffer; fileName: string }): void => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    // Sin esto el navegador no puede leer el nombre del archivo desde otro origen.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(file.pdf);
};

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
}
