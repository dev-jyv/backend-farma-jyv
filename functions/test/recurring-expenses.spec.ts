/**
 * Gastos fijos: plantillas que sirven de presupuesto de referencia. A
 * contabilidad solo llega lo que se paga (`payRecurringExpense`) en su mes,
 * nunca el monto presupuestado.
 */

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

describe('presupuesto contra pagado', () => {
    it('suma presupuesto de activas y lo pagado; cuenta las que no tienen pago', () => {
        const summary = recurring.summarizeRecurringMonth(
            '2026-03',
            [
                template(),
                template({ id: 'tpl-2', category: 'electricity', concept: 'Luz', amount: 1500 }),
            ],
            [accrual({ paidTotal: 4000, balance: 5000, status: 'partial' })],
        );

        expect(summary.budgetTotal).toBe(10500);
        expect(summary.paidTotal).toBe(4000);
        expect(summary.unpaidCount).toBe(1);
    });

    it('una inactiva no presupuesta, pero conserva lo que ya se pagó', () => {
        const summary = recurring.summarizeRecurringMonth(
            '2026-03',
            [
                template({ isActive: false }),
                template({ id: 'tpl-2', isActive: false }),
            ],
            [accrual({ paidTotal: 9000, balance: 0, status: 'paid' })],
        );

        expect(summary.lines.map((line) => line.recurringExpenseId)).toEqual(['tpl-1']);
        expect(summary.budgetTotal).toBe(0);
        expect(summary.paidTotal).toBe(9000);
        expect(summary.unpaidCount).toBe(0);
    });

    it('una inactiva sin pagos no aparece en el mes', () => {
        const summary = recurring.summarizeRecurringMonth(
            '2026-03',
            [template({ isActive: false })],
            [],
        );

        expect(summary.lines).toEqual([]);
        expect(summary.paidTotal).toBe(0);
    });
});

describe('consulta del mes', () => {
    const created: string[] = [];

    afterAll(async () => {
        await Promise.all(
            created.map((id) =>
                recurring.updateRecurringExpense(id, { isActive: false }, 'test-cleanup', 'admin'),
            ),
        );
    });

    it('una plantilla activa aparece con su presupuesto y sin pagos', async () => {
        const rent = await recurring.createRecurringExpense(
            { category: 'rent', concept: unique('Renta'), amount: 8000, dueDay: 3 },
            'admin-user',
            'admin',
        );
        created.push(rent.id);

        const summary = await recurring.getRecurringMonth('2025-02');
        const line = summary.lines.find((item) => item.recurringExpenseId === rent.id);

        expect(line).toMatchObject({ budget: 8000, paid: 0, isActive: true, lastPaymentAt: null });
    });

    it('una plantilla inactiva sin pagos no aparece', async () => {
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

        const summary = await recurring.getRecurringMonth('2025-03');

        expect(summary.lines.some((item) => item.recurringExpenseId === light.id)).toBe(false);
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

    it('pagar una plantilla inexistente responde no encontrado', async () => {
        await expect(
            recurring.payRecurringExpense(
                'no-existe',
                { month: '2025-02', amount: 100, paymentMethod: 'cash' },
                'admin-user',
                'admin',
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});
