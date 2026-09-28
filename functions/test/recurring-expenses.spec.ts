/**
 * Gastos fijos: plantillas que generan, a pedido, un gasto devengado por mes.
 *
 * La regla que carga con todo es la idempotencia: generar el mismo mes dos
 * veces no puede duplicar la renta en el estado de resultados.
 */

import * as accruedRepo from '../src/repositories/accrued-expenses.repository';
import * as recurring from '../src/services/recurring-expenses.service';
import { AccruedExpenseView } from '../src/services/accounting-core.service';
import { RecurringExpense } from '../src/types';
import { fromDate } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const template = (overrides: Partial<RecurringExpense> = {}): RecurringExpense =>
    ({
        id: 'tpl-1',
        category: 'rent',
        concept: 'Renta',
        amount: 9000,
        dueDay: 5,
        isActive: true,
        createdBy: 'u-1',
        createdAt: fromDate(new Date('2026-01-01T00:00:00Z')),
        ...overrides,
    }) as RecurringExpense;

const accrual = (overrides: Partial<AccruedExpenseView>): AccruedExpenseView =>
    ({
        id: 'recurring_tpl-1_2026-03',
        category: 'rent',
        concept: 'Renta',
        amount: 9000,
        paidTotal: 0,
        balance: 9000,
        status: 'pending',
        isOverdue: false,
        recurringExpenseId: 'tpl-1',
        recurringMonth: '2026-03',
        ...overrides,
    }) as AccruedExpenseView;

describe('fechas del gasto fijo', () => {
    it('vence el día configurado a mediodía UTC para no caer en el mes anterior', () => {
        const { dueDate, accruedAt } = recurring.recurringAccrualDates(
            '2026-03',
            1,
            new Date('2026-06-01T00:00:00Z'),
        );
        expect(dueDate.toISOString()).toBe('2026-03-01T12:00:00.000Z');
        expect(accruedAt).toEqual(dueDate);
    });

    it('no devenga a futuro: si el día aún no llega, devenga hoy', () => {
        const asOf = new Date('2026-03-10T15:00:00Z');
        const { dueDate, accruedAt } = recurring.recurringAccrualDates('2026-03', 20, asOf);
        expect(dueDate.toISOString()).toBe('2026-03-20T12:00:00.000Z');
        expect(accruedAt).toEqual(asOf);
    });
});

describe('presupuesto contra real', () => {
    it('suma presupuesto de activas y lo generado y pagado', () => {
        const summary = recurring.summarizeRecurringMonth(
            '2026-03',
            [
                template(),
                template({ id: 'tpl-2', category: 'electricity', concept: 'Luz', amount: 1500 }),
            ],
            [accrual({ paidTotal: 4000, balance: 5000, status: 'partial' })],
        );

        expect(summary.budgetTotal).toBe(10500);
        expect(summary.accruedTotal).toBe(9000);
        expect(summary.paidTotal).toBe(4000);
        expect(summary.pendingToGenerate).toBe(1);
    });

    it('una inactiva no presupuesta, pero muestra lo que ya generó', () => {
        const summary = recurring.summarizeRecurringMonth(
            '2026-03',
            [
                template({ isActive: false }),
                template({ id: 'tpl-2', isActive: false }),
            ],
            [accrual({})],
        );

        expect(summary.lines.map((line) => line.recurringExpenseId)).toEqual(['tpl-1']);
        expect(summary.budgetTotal).toBe(0);
        expect(summary.accruedTotal).toBe(9000);
        expect(summary.pendingToGenerate).toBe(0);
    });
});

describe('generación del mes', () => {
    const month = '2025-02';
    const created: string[] = [];

    afterAll(async () => {
        await Promise.all(
            created.map((id) =>
                recurring.updateRecurringExpense(id, { isActive: false }, 'test-cleanup', 'admin'),
            ),
        );
    });

    it('generar el mismo mes dos veces no duplica', async () => {
        const rent = await recurring.createRecurringExpense(
            { category: 'rent', concept: unique('Renta'), amount: 8000, dueDay: 3 },
            'admin-user',
            'admin',
        );
        created.push(rent.id);

        const first = await recurring.generateRecurringMonth(month, 'admin-user', 'admin');
        const second = await recurring.generateRecurringMonth(month, 'admin-user', 'admin');

        const line = second.summary.lines.find((item) => item.recurringExpenseId === rent.id);
        expect(first.created).toBeGreaterThanOrEqual(1);
        expect(line?.accrued?.amount).toBe(8000);
        expect(line?.accrued?.accruedAt.toDate().toISOString()).toBe(
            '2025-02-03T12:00:00.000Z',
        );

        const accruals = await accruedRepo.listAccrued({
            from: new Date('2025-02-01T00:00:00Z'),
            to: new Date('2025-02-28T23:59:59Z'),
        });
        expect(accruals.filter((item) => item.recurringExpenseId === rent.id)).toHaveLength(1);
    });

    it('una plantilla inactiva no genera', async () => {
        const light = await recurring.createRecurringExpense(
            { category: 'electricity', concept: unique('Luz'), amount: 1200, dueDay: 10 },
            'admin-user',
            'admin',
        );
        created.push(light.id);
        await recurring.updateRecurringExpense(
            light.id,
            { isActive: false },
            'admin-user',
            'admin',
        );

        const result = await recurring.generateRecurringMonth('2025-03', 'admin-user', 'admin');

        expect(
            result.summary.lines.some((item) => item.recurringExpenseId === light.id),
        ).toBe(false);
        const [stored] = await accruedRepo.getByIds([
            recurring.recurringAccrualId(light.id, '2025-03'),
        ]);
        expect(stored).toBeUndefined();
    });

    it('exige descripción en las categorías que no se explican solas', async () => {
        await expect(
            recurring.createRecurringExpense(
                { category: 'supplies', concept: 'Limpieza', amount: 300, dueDay: 1 },
                'admin-user',
                'admin',
            ),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});
