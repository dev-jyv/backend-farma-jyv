/**
 * Gastos devengados y no pagados.
 *
 * La regla que carga con todo: el gasto pega en resultados el día que **se
 * devenga**, y su pago posterior solo mueve efectivo. El movimiento del pago se
 * guarda como `withdrawal` y no como `expense` justo por eso —si fuera gasto, la
 * renta de marzo pagada en abril aparecería dos veces, una en cada mes.
 */

import * as accountingCore from '../src/services/accounting-core.service';
import * as accountingService from '../src/services/accounting.service';
import * as bankService from '../src/services/bank.service';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const isoDay = (offsetDays = 0): string =>
    new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Instante propio en el pasado: el emulador es compartido entre suites. */
const ownInstant = (daysAgo: number): Date =>
    new Date(
        Date.now() - daysAgo * 24 * 60 * 60 * 1000 - Math.floor(Math.random() * 3_600_000),
    );

describe('gastos devengados', () => {
    it('nace pendiente por el total', async () => {
        const accrued = await accountingCore.createAccruedExpense(
            {
                category: 'rent',
                concept: unique('Renta'),
                amount: 9000,
                accruedAt: isoDay(-3),
            },
            'admin-user',
            'admin',
        );

        expect(accrued.paidTotal).toBe(0);
        expect(accrued.balance).toBe(9000);
        expect(accrued.status).toBe('pending');
    });

    it('exige descripción en las categorías que no se explican solas', async () => {
        await expect(
            accountingCore.createAccruedExpense(
                {
                    category: 'supplies',
                    concept: 'Compra',
                    amount: 500,
                    accruedAt: isoDay(-1),
                },
                'admin-user',
                'admin',
            ),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('el pago baja el saldo sin volver a pegar en resultados', async () => {
        const accruedAt = ownInstant(20);
        const accrued = await accountingCore.createAccruedExpense(
            {
                category: 'electricity',
                concept: unique('Luz'),
                amount: 2000,
                accruedAt: accruedAt.toISOString().slice(0, 10),
            },
            'admin-user',
            'admin',
        );

        const pagado = await accountingCore.payAccruedExpense(
            accrued.id,
            { amount: 2000, paymentMethod: 'cash', paidAt: isoDay(-1) },
            'admin-user',
            'admin',
        );

        expect(pagado.balance).toBe(0);
        expect(pagado.status).toBe('paid');

        // El día del pago no hay gasto nuevo: el movimiento es un retiro.
        const delDiaDelPago = await accountingService.listExpenses({
            from: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
        });
        expect(
            delDiaDelPago.items.some((movement) => movement.reason.includes(accrued.concept)),
        ).toBe(false);
    });

    it('rechaza el pago que supera el saldo', async () => {
        const accrued = await accountingCore.createAccruedExpense(
            {
                category: 'rent',
                concept: unique('Renta'),
                amount: 1000,
                accruedAt: isoDay(-2),
            },
            'admin-user',
            'admin',
        );

        await expect(
            accountingCore.payAccruedExpense(
                accrued.id,
                { amount: 1500, paymentMethod: 'cash' },
                'admin-user',
                'admin',
            ),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('supera el saldo'),
        });
    });
});

describe('el devengado en el estado de resultados y el balance', () => {
    it('pega en el periodo del devengo aunque no se haya pagado', async () => {
        const accruedAt = ownInstant(30);

        await accountingCore.createAccruedExpense(
            {
                category: 'salary',
                concept: unique('Nómina'),
                amount: 7500,
                accruedAt: accruedAt.toISOString().slice(0, 10),
            },
            'admin-user',
            'admin',
        );

        // Ventana del ancho del día de devengo: el emulador es compartido, pero
        // un instante propio a 30 días solo contiene este gasto.
        const dayStart = new Date(accruedAt.toISOString().slice(0, 10));
        const statement = await accountingService.getIncomeStatement({
            from: new Date(dayStart.getTime() - 1_000).toISOString(),
            to: new Date(dayStart.getTime() + 1_000).toISOString(),
        });
        const line = statement.operatingExpenses.byCategory
            .find((item) => item.category === 'salary');

        expect(line).toBeDefined();
        expect(line!.accrued).toBeGreaterThanOrEqual(7500);
        expect(statement.reliability.accruedExpenses).toBeGreaterThanOrEqual(7500);
        expect(statement.reliability.warnings.join(' ')).toContain('devengados');
    });

    it('lo no pagado vive en el pasivo del balance', async () => {
        const antes = await accountingService.getBalanceSheet();

        await accountingCore.createAccruedExpense(
            {
                category: 'rent',
                concept: unique('Renta'),
                amount: 12345,
                accruedAt: isoDay(-1),
            },
            'admin-user',
            'admin',
        );

        const despues = await accountingService.getBalanceSheet();

        expect(
            despues.liabilities.accruedExpenses - antes.liabilities.accruedExpenses,
        ).toBeGreaterThanOrEqual(12345);
        // Y el total del pasivo lo incluye: un rubro fuera del total lo
        // escondería detrás del descuadre.
        expect(despues.liabilities.total).toBeCloseTo(
            despues.liabilities.payables +
                despues.liabilities.accruedExpenses +
                despues.liabilities.taxesPayable,
            2,
        );
    });

    it('pagado por transferencia baja la cuenta bancaria', async () => {
        const account = await bankService.createAccount(
            {
                name: unique('Cuenta'),
                bank: 'BBVA',
                openingBalance: 20000,
                openingDate: isoDay(-60),
            },
            'admin-user',
            'admin',
        );

        const accrued = await accountingCore.createAccruedExpense(
            {
                category: 'rent',
                concept: unique('Renta'),
                amount: 8000,
                accruedAt: isoDay(-5),
            },
            'admin-user',
            'admin',
        );

        await accountingCore.payAccruedExpense(
            accrued.id,
            {
                amount: 8000,
                paymentMethod: 'transfer',
                bankAccountId: account.id,
                paidAt: isoDay(-1),
            },
            'admin-user',
            'admin',
        );

        const accounts = await bankService.getAccountsWithBalance({ includeInactive: true });
        const mine = accounts.find((item) => item.id === account.id)!;

        // El pago sale como retiro; si el saldo bancario solo mirara los `expense`,
        // la cuenta se quedaría inflada por el importe del pago.
        expect(mine.balance).toBeCloseTo(12000, 2);
    });
});
