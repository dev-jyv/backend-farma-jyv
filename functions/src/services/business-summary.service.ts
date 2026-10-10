import * as returnsRepo from '../repositories/sale-returns.repository';
import * as salesRepo from '../repositories/sales.repository';
import { PaymentMethod, Sale, isSaleProductItem } from '../types';
import { MemoryCache } from '../utils/memory-cache';
import { fromCents, toCents } from '../utils/taxes';
import { addDaysYmd, getZonedYmd, zonedStartOfDayMs } from '../utils/timezone';
import { REPORTS_TIME_ZONE } from './sales-reports.service';

/**
 * Resumen semanal o mensual del negocio, comparado contra el periodo anterior.
 * Es determinista —sin IA— y de costo fijo: una lectura de ventas y de
 * devoluciones por periodo (dos periodos), cacheada unos minutos.
 *
 * Diferencia con `getProfitReport`: aquel suma `costAmount ?? 0`, así que una
 * partida sin costo capturado aparece como utilidad del 100 % y el margen sale
 * inflado. Aquí el margen se calcula **solo sobre lo que sí tiene costo** y se
 * informa la cobertura de costo, para que la cifra no se lea como más sólida
 * de lo que es.
 */

export type SummaryPeriod = 'week' | 'month';

const CACHE_TTL_MS = 2 * 60 * 1000;
const TOP_PRODUCTS = 5;
const UNCOSTED_PRODUCTS = 5;

/** Umbrales de los avisos automáticos. */
const SALES_CHANGE_ALERT_PCT = 10;
const MARGIN_DROP_ALERT_PTS = 3;
const LOW_COST_COVERAGE_PCT = 80;
const TOP_CONCENTRATION_PCT = 40;

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

export interface PeriodWindow {
    /** Primer día (YYYY-MM-DD, hora local de la farmacia). */
    startYmd: string;
    /** Último día incluido. */
    endYmd: string;
    days: number;
    /** Límites para consultar Firestore: `from` inclusivo, `to` el último milisegundo. */
    from: string;
    to: string;
}

export interface ResolvedPeriods {
    period: SummaryPeriod;
    /** El periodo actual aún no termina: se compara contra los mismos días del anterior. */
    isPartial: boolean;
    current: PeriodWindow;
    previous: PeriodWindow;
}

const mondayOf = (ymd: string): string => {
    const [year, month, day] = ymd.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return addDaysYmd(ymd, -((weekday + 6) % 7));
};

const firstOfMonth = (ymd: string, monthDelta = 0): string => {
    const [year, month] = ymd.split('-').map(Number);
    const index = year * 12 + (month - 1) + monthDelta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
};

const daysBetween = (fromYmd: string, toYmd: string): number =>
    Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / (24 * 60 * 60 * 1000));

const windowOf = (startYmd: string, endExclusiveYmd: string): PeriodWindow => ({
    startYmd,
    endYmd: addDaysYmd(endExclusiveYmd, -1),
    days: daysBetween(startYmd, endExclusiveYmd),
    from: new Date(zonedStartOfDayMs(startYmd, REPORTS_TIME_ZONE)).toISOString(),
    to: new Date(zonedStartOfDayMs(endExclusiveYmd, REPORTS_TIME_ZONE) - 1).toISOString(),
});

/**
 * Semana (lunes a domingo) o mes que contiene `anchorYmd`, y el periodo
 * anterior. Si el periodo está en curso, el anterior se recorta a los mismos
 * días transcurridos: comparar tres días contra una semana completa sería
 * engañoso.
 */
export const resolvePeriods = (
    period: SummaryPeriod,
    anchorYmd: string,
    todayYmd: string,
): ResolvedPeriods => {
    // No hay futuro que resumir: un ancla posterior a hoy se corrige a hoy.
    const anchor = anchorYmd > todayYmd ? todayYmd : anchorYmd;
    const startYmd = period === 'week' ? mondayOf(anchor) : firstOfMonth(anchor);
    const nextStartYmd = period === 'week' ? addDaysYmd(startYmd, 7) : firstOfMonth(anchor, 1);
    const isPartial = todayYmd >= startYmd && todayYmd < nextStartYmd;
    const endExclusiveYmd = isPartial ? addDaysYmd(todayYmd, 1) : nextStartYmd;
    const elapsedDays = daysBetween(startYmd, endExclusiveYmd);

    const previousStartYmd = period === 'week'
        ? addDaysYmd(startYmd, -7)
        : firstOfMonth(anchor, -1);
    const previousEndExclusive = addDaysYmd(previousStartYmd, elapsedDays);

    return {
        period,
        isPartial,
        current: windowOf(startYmd, endExclusiveYmd),
        // Un mes más corto que los días transcurridos no puede invadir el actual.
        previous: windowOf(
            previousStartYmd,
            previousEndExclusive > startYmd ? startYmd : previousEndExclusive,
        ),
    };
};

// ---------------------------------------------------------------------------
// Resumen de un periodo (puro)
// ---------------------------------------------------------------------------

interface TimestampLike {
    toMillis(): number;
}

export type SummarySale = Pick<
    Sale,
    'items' | 'total' | 'paymentMethod' | 'voidedAt' | 'costTotal'
> & {
    createdAt: TimestampLike;
    discountTotal?: number;
    pharmacyTotal?: number;
    servicesTotal?: number;
    taxSummary?: { base: number; ivaTotal: number } | null;
};

export interface SummaryReturn {
    refundTotal: number;
    taxSummary?: { base: number } | null;
}

export interface ProductSummaryLine {
    productId: string;
    productName: string;
    units: number;
    /** Cobrado con impuestos. */
    revenue: number;
    /** Participación sobre el importe de mercancía del periodo, en %. */
    share: number;
}

export interface PeriodTotals {
    tickets: number;
    /** Cobrado bruto, impuestos incluidos. */
    gross: number;
    discounts: number;
    refunds: number;
    /** Bruto menos devoluciones. */
    net: number;
    taxBase: number;
    iva: number;
    ticketAverage: number;
    pharmacyTotal: number;
    servicesTotal: number;
    merchandise: {
        units: number;
        /** Base sin impuestos de la mercancía vendida. */
        base: number;
        /** Costo de las partidas que sí lo tienen. */
        cost: number;
        /** Utilidad solo de las partidas con costo (ver cabecera del archivo). */
        profit: number;
        /** Margen sobre las partidas con costo, en %; `null` si ninguna lo tiene. */
        marginRate: number | null;
        /** % de la base de mercancía que tiene costo capturado; `null` sin mercancía. */
        costCoverage: number | null;
        ticketsWithoutCost: number;
        /** Base de las partidas sin costo: venta cuyo margen se desconoce. */
        uncostedBase: number;
    };
    byDay: Array<{ date: string; tickets: number; total: number }>;
    byPayment: Array<{ method: PaymentMethod; tickets: number; total: number }>;
    topProducts: ProductSummaryLine[];
    uncostedProducts: ProductSummaryLine[];
}

interface ProductAcc {
    name: string;
    units: number;
    netCents: number;
    uncostedNetCents: number;
}

const pct = (part: number, whole: number): number | null =>
    whole > 0 ? Math.round((part / whole) * 10000) / 100 : null;

export const summarizePeriod = (
    sales: SummarySale[],
    returns: SummaryReturn[],
): PeriodTotals => {
    let grossCents = 0;
    let discountCents = 0;
    let baseCents = 0;
    let ivaCents = 0;
    let pharmacyCents = 0;
    let servicesCents = 0;
    let units = 0;
    let merchBaseCents = 0;
    let costedBaseCents = 0;
    let costCents = 0;
    let uncostedBaseCents = 0;
    let ticketsWithoutCost = 0;
    let merchNetCents = 0;

    const byDay = new Map<string, { tickets: number; cents: number }>();
    const byPayment = new Map<PaymentMethod, { tickets: number; cents: number }>();
    const products = new Map<string, ProductAcc>();

    for (const sale of sales) {
        if (sale.voidedAt) {
            continue;
        }
        const totalCents = toCents(sale.total);
        grossCents += totalCents;
        discountCents += toCents(sale.discountTotal ?? 0);
        baseCents += toCents(sale.taxSummary?.base ?? 0);
        ivaCents += toCents(sale.taxSummary?.ivaTotal ?? 0);
        servicesCents += toCents(sale.servicesTotal ?? 0);
        pharmacyCents += toCents(sale.pharmacyTotal ?? sale.total);

        const day = getZonedYmd(sale.createdAt.toMillis(), REPORTS_TIME_ZONE);
        const dayAcc = byDay.get(day) ?? { tickets: 0, cents: 0 };
        dayAcc.tickets += 1;
        dayAcc.cents += totalCents;
        byDay.set(day, dayAcc);

        const payment = byPayment.get(sale.paymentMethod) ?? { tickets: 0, cents: 0 };
        payment.tickets += 1;
        payment.cents += totalCents;
        byPayment.set(sale.paymentMethod, payment);

        let saleHasUncosted = false;
        for (const item of sale.items.filter(isSaleProductItem)) {
            const netCents = toCents(item.netAmount ?? item.subtotal - item.discountAmount);
            const lineBaseCents = item.taxes ? toCents(item.taxes.base) : netCents;
            const uncosted = item.costAmount === null || item.costAmount === undefined;

            units += item.quantity;
            merchBaseCents += lineBaseCents;
            merchNetCents += netCents;
            if (uncosted) {
                uncostedBaseCents += lineBaseCents;
                saleHasUncosted = true;
            } else {
                costedBaseCents += lineBaseCents;
                costCents += toCents(item.costAmount as number);
            }

            const acc = products.get(item.productId) ?? {
                name: item.productName,
                units: 0,
                netCents: 0,
                uncostedNetCents: 0,
            };
            acc.units += item.quantity;
            acc.netCents += netCents;
            if (uncosted) {
                acc.uncostedNetCents += netCents;
            }
            products.set(item.productId, acc);
        }
        if (saleHasUncosted) {
            ticketsWithoutCost += 1;
        }
    }

    const tickets = sales.filter((sale) => !sale.voidedAt).length;
    const refundCents = returns.reduce((total, item) => total + toCents(item.refundTotal), 0);
    const profitCents = costedBaseCents - costCents;
    const line = (productId: string, acc: ProductAcc, netCents: number): ProductSummaryLine => ({
        productId,
        productName: acc.name,
        units: acc.units,
        revenue: fromCents(netCents),
        share: pct(acc.netCents, merchNetCents) ?? 0,
    });

    return {
        tickets,
        gross: fromCents(grossCents),
        discounts: fromCents(discountCents),
        refunds: fromCents(refundCents),
        net: fromCents(grossCents - refundCents),
        taxBase: fromCents(baseCents),
        iva: fromCents(ivaCents),
        ticketAverage: tickets ? fromCents(Math.round(grossCents / tickets)) : 0,
        pharmacyTotal: fromCents(pharmacyCents),
        servicesTotal: fromCents(servicesCents),
        merchandise: {
            units,
            base: fromCents(merchBaseCents),
            cost: fromCents(costCents),
            profit: fromCents(profitCents),
            marginRate: pct(profitCents, costedBaseCents),
            costCoverage: pct(costedBaseCents, merchBaseCents),
            ticketsWithoutCost,
            uncostedBase: fromCents(uncostedBaseCents),
        },
        byDay: [...byDay.entries()]
            .map(([date, acc]) => ({ date, tickets: acc.tickets, total: fromCents(acc.cents) }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        byPayment: [...byPayment.entries()]
            .map(([method, acc]) => ({ method, tickets: acc.tickets, total: fromCents(acc.cents) }))
            .sort((a, b) => b.total - a.total),
        topProducts: [...products.entries()]
            .sort(([, a], [, b]) => b.netCents - a.netCents)
            .slice(0, TOP_PRODUCTS)
            .map(([productId, acc]) => line(productId, acc, acc.netCents)),
        // Lo que más pesa y no tiene costo: capturarlo es lo que más mejora el margen.
        uncostedProducts: [...products.entries()]
            .filter(([, acc]) => acc.uncostedNetCents > 0)
            .sort(([, a], [, b]) => b.uncostedNetCents - a.uncostedNetCents)
            .slice(0, UNCOSTED_PRODUCTS)
            .map(([productId, acc]) => line(productId, acc, acc.uncostedNetCents)),
    };
};

// ---------------------------------------------------------------------------
// Comparación y avisos
// ---------------------------------------------------------------------------

export interface Comparison {
    /** Variación porcentual; `null` cuando el periodo anterior no tiene base. */
    net: number | null;
    tickets: number | null;
    ticketAverage: number | null;
    profit: number | null;
    /** Diferencia del margen en puntos porcentuales. */
    marginPoints: number | null;
}

const change = (current: number, previous: number): number | null =>
    previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

const marginDelta = (current: number | null, previous: number | null): number | null =>
    current !== null && previous !== null ? Math.round((current - previous) * 10) / 10 : null;

export const compareTotals = (current: PeriodTotals, previous: PeriodTotals): Comparison => ({
    net: change(current.net, previous.net),
    tickets: change(current.tickets, previous.tickets),
    ticketAverage: change(current.ticketAverage, previous.ticketAverage),
    profit: change(current.merchandise.profit, previous.merchandise.profit),
    marginPoints: marginDelta(current.merchandise.marginRate, previous.merchandise.marginRate),
});

export type HighlightCode =
    | 'noSales'
    | 'salesUp'
    | 'salesDown'
    | 'marginDown'
    | 'lowCostCoverage'
    | 'refunds'
    | 'topConcentration';

export interface Highlight {
    code: HighlightCode;
    severity: 'info' | 'warn' | 'success';
    /** Valores para el texto traducido del panel. */
    params: Record<string, number>;
}

/** Avisos por reglas: los datos que merecen una mirada, sin IA ni costo. */
export const buildHighlights = (
    current: PeriodTotals,
    comparison: Comparison,
): Highlight[] => {
    if (current.tickets === 0) {
        return [{ code: 'noSales', severity: 'info', params: {} }];
    }
    const highlights: Highlight[] = [];

    if (comparison.net !== null && Math.abs(comparison.net) >= SALES_CHANGE_ALERT_PCT) {
        highlights.push({
            code: comparison.net > 0 ? 'salesUp' : 'salesDown',
            severity: comparison.net > 0 ? 'success' : 'warn',
            params: { pct: Math.abs(comparison.net) },
        });
    }
    if (comparison.marginPoints !== null && comparison.marginPoints <= -MARGIN_DROP_ALERT_PTS) {
        highlights.push({
            code: 'marginDown',
            severity: 'warn',
            params: { points: Math.abs(comparison.marginPoints) },
        });
    }
    const { costCoverage, ticketsWithoutCost } = current.merchandise;
    if (costCoverage !== null && costCoverage < LOW_COST_COVERAGE_PCT) {
        highlights.push({
            code: 'lowCostCoverage',
            severity: 'warn',
            params: { coverage: costCoverage, tickets: ticketsWithoutCost },
        });
    }
    if (current.refunds > 0) {
        highlights.push({ code: 'refunds', severity: 'info', params: { amount: current.refunds } });
    }
    const top = current.topProducts[0];
    if (top && top.share >= TOP_CONCENTRATION_PCT) {
        highlights.push({
            code: 'topConcentration',
            severity: 'info',
            params: { share: top.share },
        });
    }
    return highlights;
};

// ---------------------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------------------

export interface BusinessSummary {
    period: SummaryPeriod;
    isPartial: boolean;
    generatedAt: string;
    current: { window: PeriodWindow; totals: PeriodTotals };
    previous: { window: PeriodWindow; totals: PeriodTotals };
    comparison: Comparison;
    highlights: Highlight[];
}

const cache = new MemoryCache<BusinessSummary>(CACHE_TTL_MS, 50);

const loadTotals = async (window: PeriodWindow): Promise<PeriodTotals> => {
    const [{ items: sales }, returns] = await Promise.all([
        salesRepo.listSales({ from: window.from, to: window.to }),
        returnsRepo.listSaleReturns({ from: window.from, to: window.to }),
    ]);
    return summarizePeriod(sales, returns);
};

/**
 * Lecturas: ventas y devoluciones del periodo y del anterior (4 consultas por
 * rango de fechas, sin leer productos ni lotes). Cache de 2 minutos por
 * instancia y clave `periodo:ancla`.
 */
export const getBusinessSummary = async (
    period: SummaryPeriod,
    anchorYmd?: string,
): Promise<BusinessSummary> => {
    const todayYmd = getZonedYmd(Date.now(), REPORTS_TIME_ZONE);
    const resolved = resolvePeriods(period, anchorYmd ?? todayYmd, todayYmd);
    const key = `${period}:${resolved.current.startYmd}`;
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }

    const [current, previous] = await Promise.all([
        loadTotals(resolved.current),
        loadTotals(resolved.previous),
    ]);
    const comparison = compareTotals(current, previous);
    const summary: BusinessSummary = {
        period,
        isPartial: resolved.isPartial,
        generatedAt: new Date().toISOString(),
        current: { window: resolved.current, totals: current },
        previous: { window: resolved.previous, totals: previous },
        comparison,
        highlights: buildHighlights(current, comparison),
    };
    cache.set(key, summary);
    return summary;
};
