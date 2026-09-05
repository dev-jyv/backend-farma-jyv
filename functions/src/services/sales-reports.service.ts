import { PaymentMethod, Sale, isSaleProductItem } from '../types';
import * as salesRepo from '../repositories/sales.repository';

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

export interface DailySalesReport {
    kind: 'daily';
    title: string;
    periodLabel: string;
    totals: SalesReportTotals;
    sales: ReportSaleRow[];
    topProducts: ReportTopProduct[];
}

export interface MonthlySalesReport {
    kind: 'monthly';
    title: string;
    periodLabel: string;
    totals: SalesReportTotals;
    byDay: ReportDayRow[];
    topProducts: ReportTopProduct[];
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
    const sales = await listSalesBetween(from, to);

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

    return {
        kind: 'daily',
        title: 'Reporte diario de ventas',
        periodLabel,
        totals: buildTotals(sales),
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
    const sales = await listSalesBetween(from, to);

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

    return {
        kind: 'monthly',
        title: 'Reporte mensual de ventas',
        periodLabel,
        totals: buildTotals(sales),
        byDay,
        topProducts: buildTopProducts(sales),
    };
};
