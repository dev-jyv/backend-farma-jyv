/**
 * Series del tablero y próximos pagos de gastos fijos con casos cerrados:
 * agrupación en hora de México, huecos en cero y vencimiento del mes en curso
 * o del siguiente según esté pagado.
 */

import { AccruedExpenseView } from '../src/services/accounting-core.service';
import {
    buildSeries,
    chartPeriods,
    summarizeUpcomingFixedPayments,
} from '../src/services/dashboard-charts.service';
import { RecurringExpense } from '../src/types';

describe('chartPeriods', () => {
    it('lista todos los días del mes, con fin exclusivo al día 1 siguiente', () => {
        const { periods, from, to } = chartPeriods('day', '2026-02');
        expect(periods).toHaveLength(28);
        expect(periods[0]).toBe('2026-02-01');
        expect(periods[27]).toBe('2026-02-28');
        expect({ from, to }).toEqual({ from: '2026-02-01', to: '2026-03-01' });
    });

    it('lista los 12 meses del año', () => {
        const { periods, to } = chartPeriods('month', '2026');
        expect(periods[0]).toBe('2026-01');
        expect(periods[11]).toBe('2026-12');
        expect(to).toBe('2027-01-01');
    });

    it('lista los últimos cinco años hasta el pedido', () => {
        const { periods, from } = chartPeriods('year', '2026');
        expect(periods).toEqual(['2022', '2023', '2024', '2025', '2026']);
        expect(from).toBe('2022-01-01');
    });
});

describe('buildSeries', () => {
    it('agrupa por día local: las 23:00 de México del día 1 no caen en el día 2', () => {
        const { periods } = chartPeriods('day', '2026-09');
        const series = buildSeries(
            [
                { date: new Date('2026-09-02T05:00:00.000Z'), amount: 100.1 },
                { date: new Date('2026-09-02T06:30:00.000Z'), amount: 50.2 },
                { date: new Date('2026-09-02T18:00:00.000Z'), amount: 0.1 },
            ],
            'day',
            periods,
        );
        expect(series.points[0]).toEqual({ period: '2026-09-01', total: 100.1, count: 1 });
        expect(series.points[1]).toEqual({ period: '2026-09-02', total: 50.3, count: 2 });
        expect(series.points[2]).toEqual({ period: '2026-09-03', total: 0, count: 0 });
        expect(series.total).toBe(150.4);
        expect(series.count).toBe(3);
    });

    it('ignora lo que cae fuera de la ventana', () => {
        const series = buildSeries(
            [{ date: new Date('2025-06-10T18:00:00.000Z'), amount: 10 }],
            'month',
            chartPeriods('month', '2026').periods,
        );
        expect(series.total).toBe(0);
        expect(series.points.every((point) => point.count === 0)).toBe(true);
    });
});

describe('summarizeUpcomingFixedPayments', () => {
    const template = (overrides: Partial<RecurringExpense>): RecurringExpense => ({
        id: 't',
        category: 'rent',
        concept: 'Renta',
        amount: 8000,
        dueDay: 5,
        isActive: true,
        ...overrides,
    }) as RecurringExpense;

    const accrual = (recurringExpenseId: string, overrides: Partial<AccruedExpenseView>) =>
        ({ recurringExpenseId, balance: 0, status: 'paid', ...overrides }) as AccruedExpenseView;

    const upcoming = summarizeUpcomingFixedPayments(
        [
            template({ id: 'renta', dueDay: 5 }),
            template({ id: 'luz', concept: 'Luz', amount: 1200, dueDay: 12 }),
            template({ id: 'nomina', concept: 'Nómina', amount: 9000, dueDay: 28 }),
            template({ id: 'baja', concept: 'Baja', isActive: false }),
        ],
        [
            accrual('renta', { status: 'paid' }),
            accrual('luz', { status: 'partial', balance: 700 }),
        ],
        '2026-09-10',
    );

    it('ordena por urgencia y omite plantillas inactivas', () => {
        expect(upcoming.map((item) => item.recurringExpenseId)).toEqual(['luz', 'nomina', 'renta']);
    });

    it('lo pagado este mes pasa al vencimiento del mes siguiente', () => {
        const renta = upcoming.find((item) => item.recurringExpenseId === 'renta')!;
        expect(renta).toMatchObject({ dueDate: '2026-10-05', daysLeft: 25, generated: false });
        expect(renta.status).toBe('upcoming');
    });

    it('lo generado sin liquidar muestra el saldo y el vencimiento del mes', () => {
        const luz = upcoming.find((item) => item.recurringExpenseId === 'luz')!;
        expect(luz).toMatchObject({
            dueDate: '2026-09-12',
            daysLeft: 2,
            amount: 700,
            generated: true,
            status: 'dueSoon',
        });
    });

    it('un vencimiento pasado sin pagar queda vencido', () => {
        const [item] = summarizeUpcomingFixedPayments(
            [template({ id: 'renta', dueDay: 5 })],
            [],
            '2026-09-10',
        );
        expect(item).toMatchObject({ daysLeft: -5, status: 'overdue', amount: 8000 });
    });
});
