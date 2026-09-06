import {
    CashMovement,
    ExpenseCategory,
    PaymentMethod,
    Sale,
    isSaleProductItem,
    isSaleServiceItem,
} from '../types';
import { EXPENSE_CATEGORY_LABELS, EXPENSE_CATEGORY_ORDER } from '../constants/expenses';
import { fromCents, toCents } from '../utils/taxes';
import * as salesRepo from '../repositories/sales.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as cashMovementsRepo from '../repositories/cash-movements.repository';

export const REPORTS_TIME_ZONE = 'America/Mexico_City';
const MX_UTC_OFFSET = '-06:00';

const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'transfer', 'mixed'];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    mixed: 'Mixto',
};

export interface PaymentMethodBreakdown {
    method: PaymentMethod;
    label: string;
    count: number;
    amount: number;
}

export interface SalesReportTotals {
    salesCount: number;
    totalAmount: number;
    byPaymentMethod: PaymentMethodBreakdown[];
    voidedCount: number;
    voidedAmount: number;
}

export interface ReportSaleRow {
    folio: string;
    time: string;
    paymentMethodLabel: string;
    total: number;
}

export interface ReportTopProduct {
    productId: string;
    name: string;
    quantity: number;
    amount: number;
}

export interface ReportDayRow {
    dateLabel: string;
    count: number;
    amount: number;
}

/**
 * Una de las dos ramas del negocio. Farmacia y consultorio se cobran en la misma
 * venta, así que una venta mixta suma en las dos: por eso los `salesCount` de
 * las ramas pueden sumar más que el total de ventas del periodo.
 */
export interface ReportBranchTotals {
    salesCount: number;
    total: number;
    /** Participación sobre el total vendido, en porcentaje. */
    share: number;
}

export interface ReportServicesTotals extends ReportBranchTotals {
    /** Comisión acumulada de los prestadores; es dinero comprometido, no utilidad. */
    commissionTotal: number;
}

export interface ReportBranches {
    pharmacy: ReportBranchTotals;
    services: ReportServicesTotals;
}

export interface ReportExpenseCategoryRow {
    category: ExpenseCategory;
    label: string;
    count: number;
    amount: number;
    /** Participación sobre el gasto total del periodo, en porcentaje. */
    share: number;
}

export interface ReportExpenseRow {
    time: string;
    categoryLabel: string;
    reason: string;
    description: string | null;
    createdByLabel: string | null;
    amount: number;
}

/**
 * Solo `type: 'expense'`. Retiros y depósitos mueven efectivo entre cajón y
 * bóveda: contarlos como gasto inventaría una salida de dinero que no ocurrió.
 */
export interface ReportExpenses {
    total: number;
    count: number;
    byCategory: ReportExpenseCategoryRow[];
}

export interface ReportServiceRow {
    serviceId: string;
    name: string;
    quantity: number;
    amount: number;
}

export interface DailySalesReport {
    kind: 'daily';
    title: string;
    periodLabel: string;
    totals: SalesReportTotals;
    branches: ReportBranches;
    expenses: ReportExpenses;
    /** Detalle del día: son pocos y el admin quiere ver en qué se fue el efectivo. */
    expenseRows: ReportExpenseRow[];
    /** Devuelto en el periodo; se resta de lo vendido para el resultado. */
    refundTotal: number;
    /** `totalAmount − devoluciones − gastos`. */
    netResult: number;
    ticketAverage: number;
    sales: ReportSaleRow[];
    topProducts: ReportTopProduct[];
}

export interface MonthlySalesReport {
    kind: 'monthly';
    title: string;
    periodLabel: string;
    totals: SalesReportTotals;
    branches: ReportBranches;
    expenses: ReportExpenses;
    refundTotal: number;
    netResult: number;
    ticketAverage: number;
    byDay: ReportDayRow[];
    /** Mejor día del mes por importe; `null` si no hubo ventas. */
    bestDay: ReportDayRow | null;
    /** Promedio por día **con ventas**, no sobre los 30 del calendario. */
    dailyAverage: number;
    /** Mismo mes anterior, para saber si el mes fue mejor o peor. */
    previousMonth: {
        periodLabel: string;
        total: number;
        /** Variación porcentual contra el mes anterior; `null` si aquel fue cero. */
        changeRate: number | null;
    };
    topProducts: ReportTopProduct[];
    topServices: ReportServiceRow[];
}

export type SalesReport = DailySalesReport | MonthlySalesReport;

const dateFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: REPORTS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: REPORTS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

const monthFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: REPORTS_TIME_ZONE,
    month: 'long',
    year: 'numeric',
});

const isoDayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORTS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
});

export const getYesterdayIsoDate = (reference = new Date()): string => {
    const previousDay = new Date(reference.getTime() - 24 * 60 * 60 * 1000);
    return isoDayFormatter.format(previousDay);
};

export const getPreviousMonth = (reference = new Date()): { year: number; month: number } => {
    const [year, month] = isoDayFormatter.format(reference).split('-').map(Number);
    return month === 1
        ? { year: year - 1, month: 12 }
        : { year, month: month - 1 };
};

const buildTotals = (sales: Sale[]): SalesReportTotals => {
    const active = sales.filter((sale) => !sale.voidedAt);
    const voided = sales.filter((sale) => Boolean(sale.voidedAt));

    const byPaymentMethod = PAYMENT_METHODS.map((method) => {
        const methodSales = active.filter((sale) => sale.paymentMethod === method);
        return {
            method,
            label: PAYMENT_METHOD_LABELS[method],
            count: methodSales.length,
            amount: methodSales.reduce((sum, sale) => sum + sale.total, 0),
        };
    }).filter((entry) => entry.count > 0);

    return {
        salesCount: active.length,
        totalAmount: active.reduce((sum, sale) => sum + sale.total, 0),
        byPaymentMethod,
        voidedCount: voided.length,
        voidedAmount: voided.reduce((sum, sale) => sum + sale.total, 0),
    };
};

const buildTopProducts = (sales: Sale[], limit = 10): ReportTopProduct[] => {
    const byProduct = new Map<string, ReportTopProduct>();
    for (const sale of sales) {
        if (sale.voidedAt) {
            continue;
        }
        // Top de **productos**: las partidas de servicio tienen su propio corte.
        for (const item of sale.items.filter(isSaleProductItem)) {
            const entry = byProduct.get(item.productId) ?? {
                productId: item.productId,
                name: item.productName,
                quantity: 0,
                amount: 0,
            };
            entry.quantity += item.quantity;
            entry.amount += item.subtotal - item.discountAmount;
            byProduct.set(item.productId, entry);
        }
    }
    return [...byProduct.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit);
};


/** Participación porcentual con dos decimales; 0 cuando no hay base. */
const shareOf = (partCents: number, totalCents: number): number =>
    totalCents <= 0 ? 0 : Math.round((partCents / totalCents) * 10000) / 100;

/**
 * Separa farmacia de consultorio con los campos denormalizados de la venta
 * (`pharmacyTotal` / `servicesTotal`), sin recorrer partidas. Las ventas
 * anteriores al cobro de servicios no traen esos campos: `pharmacyTotal ?? total`
 * las deja como 100 % farmacia, que es lo que fueron.
 */
const buildBranches = (sales: Sale[]): ReportBranches => {
    const active = sales.filter((sale) => !sale.voidedAt);

    let pharmacyCents = 0;
    let pharmacyCount = 0;
    let servicesCents = 0;
    let servicesCount = 0;
    let commissionCents = 0;
    let grossCents = 0;

    for (const sale of active) {
        const saleCents = toCents(sale.total);
        const serviceCents = toCents(sale.servicesTotal ?? 0);
        const pharmaCents = toCents(sale.pharmacyTotal ?? sale.total);

        grossCents += saleCents;
        servicesCents += serviceCents;
        pharmacyCents += pharmaCents;
        commissionCents += toCents(sale.commissionTotal ?? 0);
        if (serviceCents > 0) {
            servicesCount += 1;
        }
        if (pharmaCents > 0) {
            pharmacyCount += 1;
        }
    }

    return {
        pharmacy: {
            salesCount: pharmacyCount,
            total: fromCents(pharmacyCents),
            share: shareOf(pharmacyCents, grossCents),
        },
        services: {
            salesCount: servicesCount,
            total: fromCents(servicesCents),
            share: shareOf(servicesCents, grossCents),
            commissionTotal: fromCents(commissionCents),
        },
    };
};

/** Gastos del periodo (todas las cajas, con y sin turno). */
const listExpensesBetween = async (
    fromIso: string,
    toIso: string,
): Promise<CashMovement[]> => {
    const { items } = await cashMovementsRepo.listAllMovements({
        from: fromIso,
        to: toIso,
        type: 'expense',
        page: 1,
        limit: 5000,
    });
    return items;
};

const buildExpenses = (movements: CashMovement[]): ReportExpenses => {
    const byCategory = new Map<ExpenseCategory, { count: number; cents: number }>();
    let totalCents = 0;

    for (const movement of movements) {
        const category = (movement.category ?? 'other') as ExpenseCategory;
        const entry = byCategory.get(category) ?? { count: 0, cents: 0 };
        entry.count += 1;
        entry.cents += toCents(movement.amount);
        byCategory.set(category, entry);
        totalCents += toCents(movement.amount);
    }

    const rows = EXPENSE_CATEGORY_ORDER
        .filter((category) => byCategory.has(category))
        .map((category) => {
            const entry = byCategory.get(category)!;
            return {
                category,
                label: EXPENSE_CATEGORY_LABELS[category],
                count: entry.count,
                amount: fromCents(entry.cents),
                share: shareOf(entry.cents, totalCents),
            };
        });

    return { total: fromCents(totalCents), count: movements.length, byCategory: rows };
};

const buildExpenseRows = (movements: CashMovement[]): ReportExpenseRow[] => movements
    .slice()
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
    .map((movement) => ({
        time: timeFormatter.format(movement.createdAt.toDate()),
        categoryLabel: EXPENSE_CATEGORY_LABELS[(movement.category ?? 'other') as ExpenseCategory],
        reason: movement.reason,
        description: movement.description ?? null,
        createdByLabel: movement.createdByLabel ?? null,
        amount: movement.amount,
    }));

const buildTopServices = (sales: Sale[], limit = 5): ReportServiceRow[] => {
    const byService = new Map<string, ReportServiceRow>();
    for (const sale of sales) {
        if (sale.voidedAt) {
            continue;
        }
        for (const item of sale.items.filter(isSaleServiceItem)) {
            const entry = byService.get(item.serviceId) ?? {
                serviceId: item.serviceId,
                name: item.serviceName,
                quantity: 0,
                amount: 0,
            };
            entry.quantity += item.quantity;
            entry.amount += item.subtotal - item.discountAmount;
            byService.set(item.serviceId, entry);
        }
    }
    return [...byService.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit);
};

const sumRefunds = async (fromIso: string, toIso: string): Promise<number> => {
    const returns = await returnsRepo.listSaleReturns({ from: fromIso, to: toIso });
    return fromCents(
        returns.reduce((cents, saleReturn) => cents + toCents(saleReturn.refundTotal), 0),
    );
};

/** `vendido − devuelto − gastado`: lo que de verdad quedó en el periodo. */
const netResultOf = (totalAmount: number, refundTotal: number, expenses: number): number =>
    fromCents(toCents(totalAmount) - toCents(refundTotal) - toCents(expenses));

const averageTicket = (totalAmount: number, salesCount: number): number =>
    salesCount === 0 ? 0 : fromCents(Math.round(toCents(totalAmount) / salesCount));

const listSalesBetween = async (fromIso: string, toIso: string): Promise<Sale[]> => {
    const { items } = await salesRepo.listSales({
        from: fromIso,
        to: toIso,
        includeVoided: true,
    });
    return items;
};

export const buildDailyReport = async (isoDate: string): Promise<DailySalesReport> => {
    const from = `${isoDate}T00:00:00.000${MX_UTC_OFFSET}`;
    const to = `${isoDate}T23:59:59.999${MX_UTC_OFFSET}`;
    const [sales, expenseMovements, refundTotal] = await Promise.all([
        listSalesBetween(from, to),
        listExpensesBetween(from, to),
        sumRefunds(from, to),
    ]);

    const rows: ReportSaleRow[] = sales
        .filter((sale) => !sale.voidedAt)
        .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
        .map((sale) => ({
            folio: sale.folio,
            time: timeFormatter.format(sale.createdAt.toDate()),
            paymentMethodLabel: PAYMENT_METHOD_LABELS[sale.paymentMethod],
            total: sale.total,
        }));

    const periodLabel = dateFormatter.format(new Date(`${isoDate}T12:00:00${MX_UTC_OFFSET}`));

    const totals = buildTotals(sales);
    const expenses = buildExpenses(expenseMovements);

    return {
        kind: 'daily',
        title: 'Reporte diario de ventas',
        periodLabel,
        totals,
        branches: buildBranches(sales),
        expenses,
        expenseRows: buildExpenseRows(expenseMovements),
        refundTotal,
        netResult: netResultOf(totals.totalAmount, refundTotal, expenses.total),
        ticketAverage: averageTicket(totals.totalAmount, totals.salesCount),
        sales: rows,
        topProducts: buildTopProducts(sales),
    };
};

export const buildMonthlyReport = async (
    year: number,
    month: number,
): Promise<MonthlySalesReport> => {
    const paddedMonth = String(month).padStart(2, '0');
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const from = `${year}-${paddedMonth}-01T00:00:00.000${MX_UTC_OFFSET}`;
    const to = `${year}-${paddedMonth}-${daysInMonth}T23:59:59.999${MX_UTC_OFFSET}`;

    // Mes anterior: solo se necesita el total para la comparación, no el detalle.
    const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const previousPadded = String(previous.month).padStart(2, '0');
    const previousDays = new Date(Date.UTC(previous.year, previous.month, 0)).getUTCDate();

    const [sales, expenseMovements, refundTotal, previousSales] = await Promise.all([
        listSalesBetween(from, to),
        listExpensesBetween(from, to),
        sumRefunds(from, to),
        listSalesBetween(
            `${previous.year}-${previousPadded}-01T00:00:00.000${MX_UTC_OFFSET}`,
            `${previous.year}-${previousPadded}-${previousDays}` +
                `T23:59:59.999${MX_UTC_OFFSET}`,
        ),
    ]);

    const byDayMap = new Map<string, ReportDayRow>();
    for (const sale of sales) {
        if (sale.voidedAt) {
            continue;
        }
        const dateLabel = dateFormatter.format(sale.createdAt.toDate());
        const entry = byDayMap.get(dateLabel) ?? { dateLabel, count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += sale.total;
        byDayMap.set(dateLabel, entry);
    }

    const periodLabel = monthFormatter.format(
        new Date(`${year}-${paddedMonth}-15T12:00:00${MX_UTC_OFFSET}`),
    );

    const byDay = [...byDayMap.values()].sort((a, b) =>
        a.dateLabel.localeCompare(b.dateLabel, 'es-MX'),
    );

    const totals = buildTotals(sales);
    const expenses = buildExpenses(expenseMovements);
    const previousTotal = buildTotals(previousSales).totalAmount;
    const daysWithSales = byDay.length;

    return {
        kind: 'monthly',
        title: 'Reporte mensual de ventas',
        periodLabel,
        totals,
        branches: buildBranches(sales),
        expenses,
        refundTotal,
        netResult: netResultOf(totals.totalAmount, refundTotal, expenses.total),
        ticketAverage: averageTicket(totals.totalAmount, totals.salesCount),
        byDay,
        bestDay: byDay.length
            ? byDay.reduce((best, day) => (day.amount > best.amount ? day : best))
            : null,
        dailyAverage: daysWithSales
            ? fromCents(Math.round(toCents(totals.totalAmount) / daysWithSales))
            : 0,
        previousMonth: {
            periodLabel: monthFormatter.format(
                new Date(`${previous.year}-${previousPadded}-15T12:00:00${MX_UTC_OFFSET}`),
            ),
            total: previousTotal,
            changeRate: previousTotal > 0
                ? Math.round(
                    ((totals.totalAmount - previousTotal) / previousTotal) * 10000,
                ) / 100
                : null,
        },
        topProducts: buildTopProducts(sales),
        topServices: buildTopServices(sales),
    };
};
