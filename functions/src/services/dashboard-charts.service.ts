import * as accruedRepo from '../repositories/accrued-expenses.repository';
import * as cashMovementsRepo from '../repositories/cash-movements.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as recurringRepo from '../repositories/recurring-expenses.repository';
import * as salesRepo from '../repositories/sales.repository';
import { CashMovement, ExpenseCategory, RecurringExpense } from '../types';
import { fromCents, toCents } from '../utils/taxes';
import { addDaysYmd, getZonedYmd, zonedStartOfDayMs } from '../utils/timezone';
import { AccruedExpenseView, toAccruedView } from './accounting-core.service';
import { recurringAccrualId } from './recurring-expenses.service';
import { REPORTS_TIME_ZONE } from './sales-reports.service';

/**
 * Series del tablero: ventas, compras (facturas por fecha de factura) y gastos
 * registrados en el POS, agrupados por día, mes o año **locales** de la farmacia.
 * La ventana siempre es acotada (un mes de días, un año de meses o
 * `YEARS_WINDOW` años) y los huecos se rellenan con cero para que la gráfica
 * no salte periodos.
 */

export type ChartGranularity = 'day' | 'month' | 'year';

export const YEARS_WINDOW = 5;

export interface ChartPoint {
    period: string;
    total: number;
    count: number;
}

export interface ChartSeries {
    points: ChartPoint[];
    total: number;
    count: number;
}

export interface DashboardCharts {
    granularity: ChartGranularity;
    from: string;
    to: string;
    sales: ChartSeries;
    purchases: ChartSeries;
    posExpenses: ChartSeries;
}

interface DatedAmount {
    date: Date;
    amount: number;
}

const KEY_LENGTH: Record<ChartGranularity, number> = { day: 10, month: 7, year: 4 };

const addMonthsYm = (ym: string, months: number): string => {
    const [year, month] = ym.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 7);
};

/** Periodos de la ventana en orden, como claves `YYYY-MM-DD` / `YYYY-MM` / `YYYY`. */
export const chartPeriods = (
    granularity: ChartGranularity,
    period: string,
): { periods: string[]; from: string; to: string } => {
    if (granularity === 'day') {
        const first = `${period}-01`;
        const next = `${addMonthsYm(period, 1)}-01`;
        const periods: string[] = [];
        for (let day = first; day < next; day = addDaysYmd(day, 1)) {
            periods.push(day);
        }
        return { periods, from: first, to: next };
    }
    if (granularity === 'month') {
        const periods = Array.from(
            { length: 12 },
            (_, index) => addMonthsYm(`${period}-01`, index),
        );
        return { periods, from: `${period}-01-01`, to: `${Number(period) + 1}-01-01` };
    }
    const last = Number(period);
    const periods = Array.from({ length: YEARS_WINDOW }, (_, index) =>
        String(last - YEARS_WINDOW + 1 + index),
    );
    return { periods, from: `${periods[0]}-01-01`, to: `${last + 1}-01-01` };
};

export const buildSeries = (
    items: DatedAmount[],
    granularity: ChartGranularity,
    periods: string[],
): ChartSeries => {
    const buckets = new Map(periods.map((period) => [period, { cents: 0, count: 0 }]));
    for (const item of items) {
        const key = getZonedYmd(item.date.getTime(), REPORTS_TIME_ZONE)
            .slice(0, KEY_LENGTH[granularity]);
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.cents += toCents(item.amount);
            bucket.count += 1;
        }
    }
    const points = periods.map((period) => {
        const bucket = buckets.get(period)!;
        return { period, total: fromCents(bucket.cents), count: bucket.count };
    });
    return {
        points,
        total: fromCents(points.reduce((sum, point) => sum + toCents(point.total), 0)),
        count: points.reduce((sum, point) => sum + point.count, 0),
    };
};

const isPosExpense = (movement: CashMovement): boolean =>
    movement.type === 'expense' && movement.cashSessionId !== null;

export const getDashboardCharts = async (query: {
    granularity: ChartGranularity;
    period?: string;
}): Promise<DashboardCharts> => {
    const today = getZonedYmd(Date.now(), REPORTS_TIME_ZONE);
    const period = query.period ?? today.slice(0, query.granularity === 'day' ? 7 : 4);
    const { periods, from, to } = chartPeriods(query.granularity, period);
    const start = new Date(zonedStartOfDayMs(from, REPORTS_TIME_ZONE));
    const end = new Date(zonedStartOfDayMs(to, REPORTS_TIME_ZONE));

    const [sales, invoices, movements] = await Promise.all([
        salesRepo.listSaleTotalsBetween(start, end),
        invoicesRepo.listInvoices({
            from: start.toISOString(),
            to: new Date(end.getTime() - 1).toISOString(),
        }),
        cashMovementsRepo.listForPeriod({
            from: start.toISOString(),
            to: new Date(end.getTime() - 1).toISOString(),
        }),
    ]);

    return {
        granularity: query.granularity,
        from,
        to: addDaysYmd(to, -1),
        sales: buildSeries(
            sales.map((sale) => ({ date: sale.createdAt, amount: sale.total })),
            query.granularity,
            periods,
        ),
        purchases: buildSeries(
            invoices.map((invoice) => ({
                date: invoice.invoiceDate.toDate(),
                amount: invoice.totalAmount,
            })),
            query.granularity,
            periods,
        ),
        posExpenses: buildSeries(
            movements.filter(isPosExpense).map((movement) => ({
                date: cashMovementsRepo.effectiveDate(movement),
                amount: movement.amount,
            })),
            query.granularity,
            periods,
        ),
    };
};

export interface UpcomingFixedPayment {
    recurringExpenseId: string;
    category: ExpenseCategory;
    concept: string;
    amount: number;
    dueDate: string;
    daysLeft: number;
    generated: boolean;
    status: 'overdue' | 'dueSoon' | 'upcoming';
}

const DUE_SOON_DAYS = 5;

const daysBetweenYmd = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Próximo pago de cada gasto fijo activo: el del mes en curso mientras no esté
 * pagado (aunque ya haya vencido), o el del mes siguiente si ya se liquidó.
 */
export const summarizeUpcomingFixedPayments = (
    templates: RecurringExpense[],
    accrualsThisMonth: AccruedExpenseView[],
    today: string,
): UpcomingFixedPayment[] => {
    const month = today.slice(0, 7);
    const accrualByTemplate = new Map(
        accrualsThisMonth.map((accrual) => [accrual.recurringExpenseId, accrual]),
    );

    return templates
        .filter((template) => template.isActive)
        .map((template) => {
            const accrual = accrualByTemplate.get(template.id);
            const settled = accrual?.status === 'paid';
            const dueMonth = settled ? addMonthsYm(month, 1) : month;
            const dueDate = `${dueMonth}-${String(template.dueDay).padStart(2, '0')}`;
            const daysLeft = daysBetweenYmd(today, dueDate);
            return {
                recurringExpenseId: template.id,
                category: template.category,
                concept: template.concept,
                amount: !settled && accrual ? accrual.balance : template.amount,
                dueDate,
                daysLeft,
                generated: !settled && !!accrual,
                status: daysLeft < 0 ? 'overdue' as const :
                    daysLeft <= DUE_SOON_DAYS ? 'dueSoon' as const : 'upcoming' as const,
            };
        })
        .sort((a, b) => a.daysLeft - b.daysLeft);
};

export const getUpcomingFixedPayments = async (): Promise<UpcomingFixedPayment[]> => {
    const asOf = new Date();
    const today = getZonedYmd(asOf.getTime(), REPORTS_TIME_ZONE);
    const templates = await recurringRepo.list();
    const accruals = await accruedRepo.getByIds(
        templates.map((template) => recurringAccrualId(template.id, today.slice(0, 7))),
    );
    return summarizeUpcomingFixedPayments(
        templates,
        accruals.map((accrual) => toAccruedView(accrual, asOf)),
        today,
    );
};
