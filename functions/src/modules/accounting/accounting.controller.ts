import {
    Body,
    Controller,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Res,
} from '@nestjs/common';
import { z } from 'zod';
import {
    accruedExpensesQuerySchema,
    createAccruedExpenseSchema,
    payAccruedExpenseSchema,
    balanceSheetQuerySchema,
    bankMovementsQuerySchema,
    createBankAccountSchema,
    createBankMovementSchema,
    createBankTransferSchema,
    reconcileMovementSchema,
    reconciliationQuerySchema,
    updateBankAccountSchema,
    closePeriodSchema,
    createAccountingExpenseSchema,
    createEquityMovementSchema,
    createFixedAssetSchema,
    disposeFixedAssetSchema,
    equityQuerySchema,
    idParamSchema,
    incomeStatementQuerySchema,
    listAccountingExpensesQuerySchema,
    updateAccountingExpenseSchema,
    updateAccountingSettingsSchema,
    updateFixedAssetSchema,
} from '../../schemas';
import { Response } from 'express';
import * as accountingService from '../../services/accounting.service';
import * as accountingCore from '../../services/accounting-core.service';
import * as accountingExport from '../../services/accounting-export.service';
import * as bankService from '../../services/bank.service';
import { AuthUser } from '../../types';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type IncomeStatementQuery = z.infer<typeof incomeStatementQuerySchema>;
type ListExpensesQuery = z.infer<typeof listAccountingExpensesQuerySchema>;
type CreateExpenseInput = z.infer<typeof createAccountingExpenseSchema>;
type UpdateExpenseInput = z.infer<typeof updateAccountingExpenseSchema>;
type IdParam = z.infer<typeof idParamSchema>;
type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
type CreateFixedAssetInput = z.infer<typeof createFixedAssetSchema>;
type UpdateFixedAssetInput = z.infer<typeof updateFixedAssetSchema>;
type DisposeFixedAssetInput = z.infer<typeof disposeFixedAssetSchema>;
type CreateEquityMovementInput = z.infer<typeof createEquityMovementSchema>;
type EquityQuery = z.infer<typeof equityQuerySchema>;
type UpdateSettingsInput = z.infer<typeof updateAccountingSettingsSchema>;
type ClosePeriodInput = z.infer<typeof closePeriodSchema>;
type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
type CreateBankMovementInput = z.infer<typeof createBankMovementSchema>;
type CreateBankTransferInput = z.infer<typeof createBankTransferSchema>;
type ReconcileMovementInput = z.infer<typeof reconcileMovementSchema>;
type BankMovementsQuery = z.infer<typeof bankMovementsQuerySchema>;
type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;
type CreateAccruedExpenseInput = z.infer<typeof createAccruedExpenseSchema>;
type PayAccruedExpenseInput = z.infer<typeof payAccruedExpenseSchema>;
type AccruedExpensesQuery = z.infer<typeof accruedExpensesQuerySchema>;

/**
 * Tope de renglones de una exportación. Alto a propósito: un auxiliar de gastos
 * recortado es peor que uno grande, porque el contador no tiene forma de notar
 * que le faltan movimientos.
 */
const MAX_EXPORT_ROWS = 10_000;

/** Descarga con nombre de archivo; ver el comentario de los endpoints. */
const sendFile = (
    res: Response,
    body: Buffer,
    contentType: string,
    fileName: string,
): void => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    // Sin esto el navegador no puede leer el nombre del archivo desde otro
    // origen, y la descarga cae como "download" sin extensión.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(body);
};

/**
 * Contabilidad (área `accounting`, solo admin). Separada de `reports`, que son
 * reportes de gestión bajo `dashboard`: aquí se lee la utilidad del negocio y se
 * registra dinero que sale de la farmacia, que no es la misma atribución que
 * mirar cuánto se vendió.
 */
@Controller('accounting')
export class AccountingController {
    @Get('income-statement')
    @RequirePermission('accounting', 'read')
    async incomeStatement(
        @Query(new ZodValidationPipe(incomeStatementQuerySchema)) query: IncomeStatementQuery,
    ) {
        const data = await accountingService.getIncomeStatement({
            from: query.from,
            to: query.to,
            compare: query.compare === 'true',
        });
        return { data };
    }

    /** Posición financiera **parcial**: no es un balance general. Ver el servicio. */
    @Get('financial-position')
    @RequirePermission('accounting', 'read')
    async financialPosition() {
        const data = await accountingService.getFinancialPosition();
        return { data };
    }

    /* ---------------------------------------------------------------------- */
    /*  Gastos devengados                                                     */
    /* ---------------------------------------------------------------------- */

    @Get('accrued-expenses')
    @RequirePermission('accounting', 'read')
    async listAccruedExpenses(
        @Query(new ZodValidationPipe(accruedExpensesQuerySchema)) query: AccruedExpensesQuery,
    ) {
        const result = await accountingCore.listAccruedExpenses({
            from: query.from,
            to: query.to,
            onlyPending: query.onlyPending === 'true',
        });
        return { data: result.items, pendingTotal: result.pendingTotal };
    }

    @Post('accrued-expenses')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createAccruedExpense(
        @Body(new ZodValidationPipe(createAccruedExpenseSchema)) body: CreateAccruedExpenseInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.createAccruedExpense(
            body,
            user.uid,
            user.role.slug,
            user.displayName || user.email,
        );
        return { data };
    }

    /** Liquida un gasto devengado; el movimiento sale como retiro, no como gasto. */
    @Post('accrued-expenses/:id/payments')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async payAccruedExpense(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(payAccruedExpenseSchema)) body: PayAccruedExpenseInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.payAccruedExpense(
            params.id,
            body,
            user.uid,
            user.role.slug,
            user.displayName || user.email,
        );
        return { data };
    }

    /* ---------------------------------------------------------------------- */
    /*  Bancos                                                                */
    /* ---------------------------------------------------------------------- */

    @Get('bank-accounts')
    @RequirePermission('accounting', 'read')
    async listBankAccounts(@Query('includeInactive') includeInactive?: string) {
        const data = await bankService.getAccountsWithBalance({
            includeInactive: includeInactive === 'true',
        });
        return { data };
    }

    @Post('bank-accounts')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createBankAccount(
        @Body(new ZodValidationPipe(createBankAccountSchema)) body: CreateBankAccountInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await bankService.createAccount(body, user.uid, user.role.slug);
        return { data };
    }

    @Patch('bank-accounts/:id')
    @RequirePermission('accounting', 'write')
    async updateBankAccount(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateBankAccountSchema)) body: UpdateBankAccountInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await bankService.updateAccount(params.id, body, user.uid, user.role.slug);
        return { data };
    }

    @Get('bank-movements')
    @RequirePermission('accounting', 'read')
    async listBankMovements(
        @Query(new ZodValidationPipe(bankMovementsQuerySchema)) query: BankMovementsQuery,
    ) {
        const data = await bankService.listMovements(query);
        return { data };
    }

    @Post('bank-movements')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createBankMovement(
        @Body(new ZodValidationPipe(createBankMovementSchema)) body: CreateBankMovementInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await bankService.createMovement(
            body,
            user.uid,
            user.role.slug,
            user.displayName || user.email,
        );
        return { data };
    }

    /** Traspaso caja ↔ banco; escribe las dos mitades o ninguna. */
    @Post('bank-transfers')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createBankTransfer(
        @Body(new ZodValidationPipe(createBankTransferSchema)) body: CreateBankTransferInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await bankService.createTransfer(
            body,
            user.uid,
            user.role.slug,
            user.displayName || user.email,
        );
        return { data };
    }

    @Post('bank-movements/:id/reconcile')
    @RequirePermission('accounting', 'write')
    async reconcileBankMovement(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(reconcileMovementSchema)) body: ReconcileMovementInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await bankService.setReconciled(
            params.id,
            body.reconciled,
            user.uid,
            user.role.slug,
        );
        return { data };
    }

    /** Lo que debió entrar al banco contra lo que se capturó. */
    @Get('reconciliation')
    @RequirePermission('accounting', 'read')
    async reconciliation(
        @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery,
    ) {
        const data = await bankService.getReconciliation(query);
        return { data };
    }

    /* ---------------------------------------------------------------------- */
    /*  Exportación                                                           */
    /* ---------------------------------------------------------------------- */

    /**
     * Las descargas escriben la respuesta con `@Res()` a propósito: el
     * interceptor de la app envuelve todo en `{ data }`, y un PDF envuelto en
     * JSON no lo abre nadie.
     */
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
        sendFile(
            res,
            await accountingExport.incomeStatementPdf(statement),
            'application/pdf',
            `estado-de-resultados-${query.from.slice(0, 10)}_${query.to.slice(0, 10)}.pdf`,
        );
    }

    @Get('exports/income-statement.csv')
    @RequirePermission('accounting', 'read')
    async exportIncomeStatementCsv(
        @Query(new ZodValidationPipe(incomeStatementQuerySchema)) query: IncomeStatementQuery,
        @Res() res: Response,
    ) {
        const statement = await accountingService.getIncomeStatement({
            from: query.from,
            to: query.to,
        });
        sendFile(
            res,
            Buffer.from(accountingExport.incomeStatementCsv(statement), 'utf8'),
            'text/csv; charset=utf-8',
            `estado-de-resultados-${query.from.slice(0, 10)}_${query.to.slice(0, 10)}.csv`,
        );
    }

    @Get('exports/balance-sheet.pdf')
    @RequirePermission('accounting', 'read')
    async exportBalanceSheetPdf(
        @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
        @Res() res: Response,
    ) {
        const balance = await accountingService.getBalanceSheet(query);
        sendFile(
            res,
            await accountingExport.balanceSheetPdf(balance),
            'application/pdf',
            `balance-general-${balance.asOf.slice(0, 10)}.pdf`,
        );
    }

    /** Auxiliar de gastos del periodo, con los dos orígenes. */
    @Get('exports/expenses.csv')
    @RequirePermission('accounting', 'read')
    async exportExpensesCsv(
        @Query(new ZodValidationPipe(listAccountingExpensesQuerySchema)) query: ListExpensesQuery,
        @Res() res: Response,
    ) {
        const result = await accountingService.listExpenses({
            from: query.from,
            to: query.to,
            category: query.category,
            paymentMethod: query.paymentMethod,
            origin: query.origin,
            // El archivo va completo: paginar una exportación deja al contador
            // con los primeros renglones y sin aviso de que faltan.
            limit: MAX_EXPORT_ROWS,
            maxLimit: MAX_EXPORT_ROWS,
        });
        sendFile(
            res,
            Buffer.from(accountingExport.expensesCsv(result.items), 'utf8'),
            'text/csv; charset=utf-8',
            'auxiliar-de-gastos.csv',
        );
    }

    @Get('exports/payables.csv')
    @RequirePermission('accounting', 'read')
    async exportPayablesCsv(@Res() res: Response) {
        const report = await accountingService.getPayables();
        sendFile(
            res,
            Buffer.from(accountingExport.payablesCsv(report), 'utf8'),
            'text/csv; charset=utf-8',
            'cuentas-por-pagar.csv',
        );
    }

    @Get('exports/fixed-assets.csv')
    @RequirePermission('accounting', 'read')
    async exportFixedAssetsCsv(@Res() res: Response) {
        const result = await accountingCore.listFixedAssets({ includeDisposed: true });
        sendFile(
            res,
            Buffer.from(accountingExport.fixedAssetsCsv(result.items), 'utf8'),
            'text/csv; charset=utf-8',
            'activo-fijo.csv',
        );
    }

    /**
     * Balance general. Efectivo y bancos son **estimados** hasta que exista
     * conciliación bancaria, y el descuadre viaja en `check`; ver el servicio.
     */
    @Get('balance-sheet')
    @RequirePermission('accounting', 'read')
    async balanceSheet(
        @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
    ) {
        const data = await accountingService.getBalanceSheet(query);
        return { data };
    }

    @Get('settings')
    @RequirePermission('accounting', 'read')
    async settings() {
        const data = await accountingCore.getSettings();
        return { data };
    }

    /** Fecha de arranque contable y saldos de apertura. */
    @Put('settings')
    @RequirePermission('accounting', 'write')
    async updateSettings(
        @Body(new ZodValidationPipe(updateAccountingSettingsSchema)) body: UpdateSettingsInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.updateSettings(body, user.uid, user.role.slug);
        return { data };
    }

    /** Cierra periodos hasta una fecha; con `through: null` los reabre. */
    @Post('close-period')
    @RequirePermission('accounting', 'write')
    async closePeriod(
        @Body(new ZodValidationPipe(closePeriodSchema)) body: ClosePeriodInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.closePeriod(body.through, user.uid, user.role.slug);
        return { data };
    }

    @Get('fixed-assets')
    @RequirePermission('accounting', 'read')
    async listFixedAssets(@Query('includeDisposed') includeDisposed?: string) {
        const result = await accountingCore.listFixedAssets({
            includeDisposed: includeDisposed === 'true',
        });
        return { data: result.items, totals: result.totals };
    }

    @Post('fixed-assets')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createFixedAsset(
        @Body(new ZodValidationPipe(createFixedAssetSchema)) body: CreateFixedAssetInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.createFixedAsset(body, user.uid, user.role.slug);
        return { data };
    }

    @Patch('fixed-assets/:id')
    @RequirePermission('accounting', 'write')
    async updateFixedAsset(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateFixedAssetSchema)) body: UpdateFixedAssetInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.updateFixedAsset(
            params.id,
            body,
            user.uid,
            user.role.slug,
        );
        return { data };
    }

    /** Baja del bien: deja de depreciarse desde la fecha indicada. */
    @Post('fixed-assets/:id/dispose')
    @RequirePermission('accounting', 'write')
    async disposeFixedAsset(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(disposeFixedAssetSchema)) body: DisposeFixedAssetInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.disposeFixedAsset(
            params.id,
            body,
            user.uid,
            user.role.slug,
        );
        return { data };
    }

    @Get('equity')
    @RequirePermission('accounting', 'read')
    async listEquity(
        @Query(new ZodValidationPipe(equityQuerySchema)) query: EquityQuery,
    ) {
        const data = await accountingCore.listEquityMovements(query);
        return { data };
    }

    @Post('equity')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createEquityMovement(
        @Body(new ZodValidationPipe(createEquityMovementSchema)) body: CreateEquityMovementInput,
        @CurrentUser() user: AuthUser,
    ) {
        const data = await accountingCore.createEquityMovement(
            body,
            user.uid,
            user.role.slug,
            user.displayName || user.email,
        );
        return { data };
    }

    /** Saldo a proveedores por antigüedad; el pasivo del balance. */
    @Get('payables')
    @RequirePermission('accounting', 'read')
    async payables() {
        const data = await accountingService.getPayables();
        return { data };
    }

    @Get('expenses')
    @RequirePermission('accounting', 'read')
    async listExpenses(
        @Query(new ZodValidationPipe(listAccountingExpensesQuerySchema)) query: ListExpensesQuery,
    ) {
        const result = await accountingService.listExpenses({
            from: query.from,
            to: query.to,
            category: query.category,
            paymentMethod: query.paymentMethod,
            origin: query.origin,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
        return { data: result.items, meta: result.meta };
    }

    @Post('expenses')
    @HttpCode(201)
    @RequirePermission('accounting', 'write')
    async createExpense(
        @Body(new ZodValidationPipe(createAccountingExpenseSchema)) body: CreateExpenseInput,
        @CurrentUser() user: AuthUser,
    ) {
        const movement = await accountingService.createExpense(
            user.uid,
            user.role.slug,
            // La etiqueta la pone el servidor, igual que en el POS: aceptarla del
            // cuerpo permitiría firmar el gasto a nombre de otro.
            user.displayName || user.email,
            body,
        );
        return { data: movement };
    }

    @Patch('expenses/:id')
    @RequirePermission('accounting', 'write')
    async updateExpense(
        @Param(new ZodValidationPipe(idParamSchema)) params: IdParam,
        @Body(new ZodValidationPipe(updateAccountingExpenseSchema)) body: UpdateExpenseInput,
        @CurrentUser() user: AuthUser,
    ) {
        const movement = await accountingService.updateExpense(
            params.id,
            user.uid,
            user.role.slug,
            body,
        );
        return { data: movement };
    }
}
