import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { balanceSheetQuerySchema, incomeStatementQuerySchema } from '../../schemas';
import * as accountingService from '../../services/accounting.service';
import * as accountingExport from '../../services/accounting-export.service';
import { sendFile } from '../../common/send-file';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

type IncomeStatementQuery = z.infer<typeof incomeStatementQuerySchema>;
type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;

/**
 * PDF de contabilidad (`/accounting/exports/*.pdf`, área `accounting`). Lanzan
 * Chromium, así que viven en la función `reportsPdf` (SPEC 38); mientras el panel
 * viejo siga en producción la misma clase también se registra en `api`. Los CSV
 * de contabilidad no usan Chromium y se quedan en `AccountingController`.
 *
 * Escriben la respuesta con `@Res()` a propósito: el interceptor de la app
 * envuelve todo en `{ data }`, y un PDF envuelto en JSON no lo abre nadie.
 */
@Controller('accounting')
export class AccountingPdfExportsController {
    @Get('exports/income-statement.pdf')
    @RequirePermission('accounting', 'read')
    async exportIncomeStatementPdf(
        @Query(new ZodValidationPipe(incomeStatementQuerySchema)) query: IncomeStatementQuery,
        @Res() res: Response,
    ) {
        const statement = await accountingService.getIncomeStatement({
            from: query.from,
            to: query.to,
            compare: query.compare === 'true',
        });
        sendFile(res, {
            body: await accountingExport.incomeStatementPdf(statement),
            contentType: 'application/pdf',
            fileName:
                `estado-de-resultados-${query.from.slice(0, 10)}_${query.to.slice(0, 10)}.pdf`,
        });
    }

    @Get('exports/balance-sheet.pdf')
    @RequirePermission('accounting', 'read')
    async exportBalanceSheetPdf(
        @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
        @Res() res: Response,
    ) {
        const balance = await accountingService.getBalanceSheet(query);
        sendFile(res, {
            body: await accountingExport.balanceSheetPdf(balance),
            contentType: 'application/pdf',
            fileName: `balance-general-${balance.asOf.slice(0, 10)}.pdf`,
        });
    }
}
