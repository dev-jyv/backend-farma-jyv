import {
    CashMovement,
    ExpenseCategory,
    PaymentMethod,
    Sale,
    isSaleProductItem,
    isSaleServiceItem,
    saleBusinessAt,
    SALE_REVIEW_FILTERS,
} from '../types';
import { EXPENSE_CATEGORY_LABELS, EXPENSE_CATEGORY_ORDER } from '../constants/expenses';
import { getPriceDeviationAlertMxn } from '../config/env';
import { priceDeviationLines } from '../utils/price-deviation';
import { fromCents, toCents } from '../utils/taxes';
import { APP_TIME_ZONE } from '../utils/timezone';
import * as salesRepo from '../repositories/sales.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as cashMovementsRepo from '../repositories/cash-movements.repository';
import * as dailyStatsRepo from '../repositories/daily-stats.repository';
import * as unreconciledRepo from '../repositories/unreconciled-sales.repository';
import * as auditRepo from '../repositories/audit-logs.repository';
import * as usersRepo from '../repositories/users.repository';

export const REPORTS_TIME_ZONE = APP_TIME_ZONE;
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
    /** Ventas con al menos una promoción y cuánto se descontó por ellas. */
    promotionSalesCount: number;
    promotionDiscountTotal: number;
    /** Ventas con cupón y cuánto se descontó por él (SPEC 47). */
    couponSalesCount: number;
    couponDiscountTotal: number;
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

/**
 * Ventas del periodo con una promo aceptada fuera de vigencia
 * (`Sale.promotionReview`). No se rechazaron —el cliente ya pagó ese precio—,
 * así que alguien tiene que mirarlas: el reporte las lista por folio para que
 * no se queden solo en un filtro del admin que nadie abre.
 */
export interface ReportPromotionReview {
    count: number;
    /** En orden de cobro. */
    folios: string[];
}

/**
 * Ventas offline registradas con marca de revisión (SPEC 52): con faltante de
 * stock, con catálogo inactivo o cobradas con el turno ya cerrado. Se aceptaron
 * porque el cliente ya pagó; el correo da el conteo y los folios de cada una.
 */
export interface ReportSaleReview {
    stock: ReportPromotionReview;
    catalog: ReportPromotionReview;
    late: ReportPromotionReview;
}

/**
 * Ventas no conciliadas **pendientes** de cualquier fecha (SPEC 53): dinero
 * cobrado que no está en las cifras de arriba ni en el corte hasta que alguien
 * lo resuelva en el panel.
 */
export interface ReportUnreconciledPending {
    count: number;
    total: number;
}

/**
 * Partidas del día cobradas **por debajo** del precio de catálogo (SPEC 64). El
 * detalle, con las cobradas por encima, está en el reporte `precio-distinto`.
 */
export interface ReportPriceDeviation {
    count: number;
    /** Pesos dejados de cobrar contra el catálogo; positivo. */
    amount: number;
    /** `PRICE_DEVIATION_ALERT_MXN` al armar el reporte. */
    threshold: number;
    /** `amount > threshold`: el correo destaca la línea. */
    alert: boolean;
}

/** Cambio de grupo COFEPRIS del día (`product.controlled_group_changed`, SPEC 64). */
export interface ReportControlledGroupChange {
    time: string;
    productName: string;
    /** `null`: sin grupo. */
    before: string | null;
    after: string | null;
    userLabel: string;
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
    promotionReview: ReportPromotionReview;
    saleReview: ReportSaleReview;
    unreconciledPending: ReportUnreconciledPending;
    priceDeviation: ReportPriceDeviation;
    controlledGroupChanges: ReportControlledGroupChange[];
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
    promotionReview: ReportPromotionReview;
    saleReview: ReportSaleReview;
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
        promotionSalesCount: active.filter((sale) => (sale.promotionDiscountTotal ?? 0) > 0)
            .length,
        promotionDiscountTotal: active.reduce(
            (sum, sale) => sum + (sale.promotionDiscountTotal ?? 0),
            0,
        ),
        couponSalesCount: active.filter((sale) => (sale.couponDiscountTotal ?? 0) > 0).length,
        couponDiscountTotal: fromCents(active.reduce(
            (sum, sale) => sum + toCents(sale.couponDiscountTotal ?? 0),
            0,
        )),
    };
};

/** Orden de cobro: fecha de negocio, con la de recepción en ventas anteriores. */
const byBusinessTime = (a: Sale, b: Sale): number =>
    saleBusinessAt(a).toMillis() - saleBusinessAt(b).toMillis();

/** Las anuladas no: ya no hay precio que revisar. */
const buildPromotionReview = (sales: Sale[]): ReportPromotionReview => {
    const flagged = sales
        .filter((sale) => !sale.voidedAt && sale.promotionReview === true)
        .sort(byBusinessTime);
    return { count: flagged.length, folios: flagged.map((sale) => sale.folio) };
};

/** Conteo y folios por marca de revisión; las anuladas no cuentan. */
const buildSaleReview = (sales: Sale[]): ReportSaleReview => {
    const active = sales.filter((sale) => !sale.voidedAt).sort(byBusinessTime);
    const of = (kind: keyof ReportSaleReview): ReportPromotionReview => {
        const flagged = active.filter(SALE_REVIEW_FILTERS[kind]);
        return { count: flagged.length, folios: flagged.map((sale) => sale.folio) };
    };
    return { stock: of('stock'), catalog: of('catalog'), late: of('late') };
};

/** Las anuladas no cuentan: ese precio ya no se cobró. */
const buildPriceDeviation = (sales: Sale[], threshold: number): ReportPriceDeviation => {
    let count = 0;
    let cents = 0;
    for (const sale of sales) {
        if (sale.voidedAt) {
            continue;
        }
        for (const line of priceDeviationLines(sale)) {
            if (line.difference < 0) {
                count += 1;
                cents += toCents(-line.difference);
            }
        }
    }
    const amount = fromCents(cents);
    return { count, amount, threshold, alert: amount > threshold };
};

const groupOf = (value: unknown): string | null =>
    (typeof value === 'string' && value ? value : null);

/**
 * Cambios de grupo controlado del día, en orden. La bitácora se lee por el rango
 * del día (índice de un campo) y se filtra la acción en memoria: un día de
 * bitácora es poco y así no hace falta un índice compuesto.
 */
const listControlledGroupChanges = async (
    fromIso: string,
    toIso: string,
): Promise<ReportControlledGroupChange[]> => {
    const logs = (await auditRepo.listAuditLogs({
        action: 'product.controlled_group_changed',
        from: fromIso,
        to: toIso,
    })).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
    const uids = [...new Set(logs.map((log) => log.userId))];
    const profiles = await Promise.all(
        uids.map((uid) => usersRepo.getUserProfile(uid).catch(() => null)),
    );
    const names = new Map(uids.map((uid, index) => [
        uid,
        profiles[index]?.displayName?.trim() || profiles[index]?.email?.trim() || uid,
    ]));
    return logs.map((log) => {
        const change = log.changes?.controlledGroup;
        return {
            time: timeFormatter.format(log.createdAt.toDate()),
            productName: typeof log.metadata?.productName === 'string'
                ? log.metadata.productName
                : log.entityId,
            before: groupOf(change?.before),
            after: groupOf(change?.after),
            userLabel: log.userId === 'system' ? 'Sistema' : names.get(log.userId) ?? log.userId,
        };
    });
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

/**
 * Ventas del periodo por **fecha de negocio** (SPEC 51): la venta offline del 31
 * a las 23:50 que sincroniza el 1 sale en el reporte del 31.
 */
const listSalesBetween = async (fromIso: string, toIso: string): Promise<Sale[]> => {
    const { items } = await salesRepo.listSales({
        from: fromIso,
        to: toIso,
        includeVoided: true,
        byBusinessDate: true,
    });
    return items;
};

export const buildDailyReport = async (isoDate: string): Promise<DailySalesReport> => {
    const from = `${isoDate}T00:00:00.000${MX_UTC_OFFSET}`;
    const to = `${isoDate}T23:59:59.999${MX_UTC_OFFSET}`;
    const [
        sales,
        expenseMovements,
        refundTotal,
        unreconciledPending,
        controlledGroupChanges,
    ] = await Promise.all([
        listSalesBetween(from, to),
        listExpensesBetween(from, to),
        sumRefunds(from, to),
        unreconciledRepo.summarizePendingUnreconciledSales(),
        listControlledGroupChanges(from, to),
    ]);

    const rows: ReportSaleRow[] = sales
        .filter((sale) => !sale.voidedAt)
        .sort(byBusinessTime)
        .map((sale) => ({
            folio: sale.folio,
            time: timeFormatter.format(saleBusinessAt(sale).toDate()),
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
        promotionReview: buildPromotionReview(sales),
        saleReview: buildSaleReview(sales),
        unreconciledPending,
        priceDeviation: buildPriceDeviation(sales, getPriceDeviationAlertMxn()),
        controlledGroupChanges,
    };
};

/** Total vendido (sin anuladas) de un mes calendario local, desde `dailyStats`. */
const previousMonthTotal = async (year: number, month: number): Promise<number> => {
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const nextFirst = `${next.year}-${String(next.month).padStart(2, '0')}-01`;
    const days = await dailyStatsRepo.listDailyStats(first, nextFirst);
    return fromCents(days.reduce((cents, day) => cents + day.salesTotalCents, 0));
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

    // El total del mes anterior sale del agregado diario (~31 lecturas) en vez
    // de leer todas las ventas del mes.
    const [sales, expenseMovements, refundTotal, previousTotal] = await Promise.all([
        listSalesBetween(from, to),
        listExpensesBetween(from, to),
        sumRefunds(from, to),
        previousMonthTotal(previous.year, previous.month),
    ]);

    const byDayMap = new Map<string, ReportDayRow>();
    for (const sale of sales) {
        if (sale.voidedAt) {
            continue;
        }
        const dateLabel = dateFormatter.format(saleBusinessAt(sale).toDate());
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
        promotionReview: buildPromotionReview(sales),
        saleReview: buildSaleReview(sales),
    };
};
