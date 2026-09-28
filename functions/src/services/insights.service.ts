import { Batch, Product, Sale, isSaleProductItem } from '../types';
import { fromCents, toCents } from '../utils/taxes';
import * as salesRepo from '../repositories/sales.repository';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';
import { REPORTS_TIME_ZONE } from './sales-reports.service';

/**
 * Indicadores de gestión que no caben en los reportes de venta: ABC, horas
 * pico, caducidad, resurtido y clientes que regresan. Las reglas de cálculo son
 * funciones puras para poder fijarlas con casos cerrados; lo que lee Firestore
 * solo arma sus entradas.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  ABC                                                                       */
/* -------------------------------------------------------------------------- */

export type AbcClass = 'A' | 'B' | 'C';

export interface AbcSummary {
    classes: Array<{ abcClass: AbcClass; productCount: number; total: number; share: number }>;
}

const ABC_CLASSES: AbcClass[] = ['A', 'B', 'C'];

/**
 * Clasifica por valor acumulado (utilidad en `top-products`): A hasta el 80 %,
 * B hasta el 95 %, C el resto; un valor cero o negativo siempre es C.
 * Decide la participación acumulada **antes** del producto, así que el que
 * cruza el 80 % todavía es A: sin él, la clase A no llegaría al 80 %.
 */
export const classifyAbc = <T extends { total: number }>(
    items: T[],
): Array<T & { abcClass: AbcClass }> => {
    const sorted = [...items].sort((a, b) => b.total - a.total);
    const grandCents = sorted.reduce((sum, item) => sum + Math.max(toCents(item.total), 0), 0);
    let cumulativeCents = 0;
    return sorted.map((item) => {
        const shareBefore = grandCents > 0 ? (cumulativeCents / grandCents) * 100 : 100;
        cumulativeCents += Math.max(toCents(item.total), 0);
        const abcClass: AbcClass =
            item.total <= 0 ? 'C' : shareBefore < 80 ? 'A' : shareBefore < 95 ? 'B' : 'C';
        return { ...item, abcClass };
    });
};

export const summarizeAbc = (
    classified: Array<{ total: number; abcClass: AbcClass }>,
): AbcSummary => {
    const grandCents = classified.reduce(
        (sum, item) => sum + Math.max(toCents(item.total), 0),
        0,
    );
    return {
        classes: ABC_CLASSES.map((abcClass) => {
            const members = classified.filter((item) => item.abcClass === abcClass);
            const cents = members.reduce((sum, item) => sum + toCents(item.total), 0);
            return {
                abcClass,
                productCount: members.length,
                total: fromCents(cents),
                share: grandCents > 0 ? Math.round((cents / grandCents) * 10000) / 100 : 0,
            };
        }),
    };
};

/* -------------------------------------------------------------------------- */
/*  Ventas por hora y día de la semana                                        */
/* -------------------------------------------------------------------------- */

export interface ByHourReport {
    byHour: Array<{ hour: number; salesCount: number; total: number }>;
    /** 0 = domingo. */
    byWeekday: Array<{ weekday: number; salesCount: number; total: number }>;
}

const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTS_TIME_ZONE,
    hour: 'numeric',
    hourCycle: 'h23',
});

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORTS_TIME_ZONE,
    weekday: 'short',
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Hora y día **locales** de la farmacia: la Function corre en UTC. */
export const zonedHourAndWeekday = (date: Date): { hour: number; weekday: number } => ({
    hour: Number(hourFormatter.format(date)) % 24,
    weekday: WEEKDAYS.indexOf(weekdayFormatter.format(date)),
});

export const summarizeByHour = (
    sales: Array<{ createdAt: Date; total: number }>,
): ByHourReport => {
    const hours = Array.from({ length: 24 }, () => ({ salesCount: 0, cents: 0 }));
    const weekdays = Array.from({ length: 7 }, () => ({ salesCount: 0, cents: 0 }));
    for (const sale of sales) {
        const { hour, weekday } = zonedHourAndWeekday(sale.createdAt);
        for (const bucket of [hours[hour], weekdays[weekday]]) {
            bucket.salesCount += 1;
            bucket.cents += toCents(sale.total);
        }
    }
    return {
        byHour: hours.map((bucket, hour) => ({
            hour,
            salesCount: bucket.salesCount,
            total: fromCents(bucket.cents),
        })),
        byWeekday: weekdays.map((bucket, weekday) => ({
            weekday,
            salesCount: bucket.salesCount,
            total: fromCents(bucket.cents),
        })),
    };
};

export const getSalesByHour = async (filters: {
    from?: string;
    to?: string;
}): Promise<ByHourReport> => {
    const { items } = await salesRepo.listSales({ from: filters.from, to: filters.to });
    return summarizeByHour(
        items.map((sale) => ({ createdAt: sale.createdAt.toDate(), total: sale.total })),
    );
};

/* -------------------------------------------------------------------------- */
/*  Caducidad                                                                 */
/* -------------------------------------------------------------------------- */

export type ExpiryBucket = 'expired' | 'days30' | 'days60' | 'days90';

export interface ExpiryReport {
    buckets: Array<{ bucket: ExpiryBucket; batchCount: number; quantity: number; value: number }>;
    /** Lotes vencidos o por vencer sin costo capturado: su valor cuenta como cero. */
    batchesWithoutCost: number;
    items: Array<{
        batchId: string;
        productId: string;
        productName: string;
        lotNumber: string;
        expiryDate: string;
        daysToExpiry: number;
        quantity: number;
        value: number;
        bucket: ExpiryBucket;
    }>;
}

const EXPIRY_BUCKETS: ExpiryBucket[] = ['expired', 'days30', 'days60', 'days90'];

/** `null` si vence después de 90 días: no entra al reporte. */
export const expiryBucketOf = (daysToExpiry: number): ExpiryBucket | null => {
    if (daysToExpiry < 0) return 'expired';
    if (daysToExpiry <= 30) return 'days30';
    if (daysToExpiry <= 60) return 'days60';
    if (daysToExpiry <= 90) return 'days90';
    return null;
};

/** Valor en riesgo a costo del lote (cantidad × costo), no a precio de venta. */
export const bucketExpiry = (
    batches: Array<Pick<Batch, 'id' | 'productId' | 'lotNumber' | 'quantity' | 'costPrice'> & {
        expiryDate: Date;
    }>,
    productNames: Map<string, string>,
    asOf: Date,
    limit = 50,
): ExpiryReport => {
    const items = batches.flatMap((batch) => {
        const daysToExpiry = Math.floor((batch.expiryDate.getTime() - asOf.getTime()) / MS_PER_DAY);
        const bucket = expiryBucketOf(daysToExpiry);
        if (!bucket || batch.quantity <= 0) {
            return [];
        }
        return [{
            batchId: batch.id,
            productId: batch.productId,
            productName: productNames.get(batch.productId) ?? batch.productId,
            lotNumber: batch.lotNumber,
            expiryDate: batch.expiryDate.toISOString().slice(0, 10),
            daysToExpiry,
            quantity: batch.quantity,
            valueCents: batch.costPrice ? Math.round(batch.quantity * toCents(batch.costPrice)) : 0,
            hasCost: !!batch.costPrice,
            bucket,
        }];
    });

    return {
        buckets: EXPIRY_BUCKETS.map((bucket) => {
            const members = items.filter((item) => item.bucket === bucket);
            return {
                bucket,
                batchCount: members.length,
                quantity: members.reduce((sum, item) => sum + item.quantity, 0),
                value: fromCents(members.reduce((sum, item) => sum + item.valueCents, 0)),
            };
        }),
        batchesWithoutCost: items.filter((item) => !item.hasCost).length,
        items: items
            .sort((a, b) => a.daysToExpiry - b.daysToExpiry)
            .slice(0, limit)
            .map(({ valueCents, hasCost: _hasCost, ...item }) => ({
                ...item,
                value: fromCents(valueCents),
            })),
    };
};

const productNameMap = (products: Product[]): Map<string, string> =>
    new Map(products.map((product) => [product.id, product.name]));

export const getExpiryReport = async (options: { limit?: number } = {}): Promise<ExpiryReport> => {
    const [batches, products] = await Promise.all([
        batchesRepo.listBatchesWithStock(),
        productsRepo.listProducts({ activeOnly: false }),
    ]);
    return bucketExpiry(
        batches.map((batch) => ({ ...batch, expiryDate: batch.expiryDate.toDate() })),
        productNameMap(products),
        new Date(),
        options.limit,
    );
};

/* -------------------------------------------------------------------------- */
/*  Sugerencia de resurtido                                                   */
/* -------------------------------------------------------------------------- */

export interface ReorderLine {
    productId: string;
    productName: string;
    sku: string;
    stock: number;
    minStock: number;
    soldQuantity: number;
    averageDaily: number;
    /** Días que alcanza la existencia al ritmo actual; `null` si no se vendió. */
    daysOfCover: number | null;
    suggestedQuantity: number;
}

export interface ReorderReport {
    windowDays: number;
    coverDays: number;
    items: ReorderLine[];
}

/**
 * Pide lo que falta para cubrir `coverDays` de venta promedio, sin quedar bajo
 * el mínimo del catálogo. Solo sugiere: la compra la decide quien compra.
 */
export const reorderSuggestion = (input: {
    stock: number;
    minStock: number;
    soldQuantity: number;
    windowDays: number;
    coverDays: number;
}): { averageDaily: number; daysOfCover: number | null; suggestedQuantity: number } => {
    const averageDaily = input.windowDays > 0 ? input.soldQuantity / input.windowDays : 0;
    const target = Math.max(Math.ceil(averageDaily * input.coverDays), input.minStock);
    return {
        averageDaily: Math.round(averageDaily * 100) / 100,
        daysOfCover: averageDaily > 0 ? Math.round((input.stock / averageDaily) * 10) / 10 : null,
        suggestedQuantity: Math.max(target - input.stock, 0),
    };
};

const soldQuantityByProduct = (sales: Sale[]): Map<string, number> => {
    const sold = new Map<string, number>();
    for (const sale of sales) {
        for (const item of sale.items.filter(isSaleProductItem)) {
            sold.set(item.productId, (sold.get(item.productId) ?? 0) + item.quantity);
        }
    }
    return sold;
};

export const getReorderSuggestions = async (options: {
    windowDays?: number;
    coverDays?: number;
    limit?: number;
} = {}): Promise<ReorderReport> => {
    const windowDays = options.windowDays ?? 30;
    const coverDays = options.coverDays ?? 7;
    const [products, batches, { items: sales }] = await Promise.all([
        productsRepo.listProducts({ activeOnly: true }),
        batchesRepo.listBatchesWithStock(),
        salesRepo.listSales({ from: new Date(Date.now() - windowDays * MS_PER_DAY).toISOString() }),
    ]);

    const stockByProduct = new Map<string, number>();
    for (const batch of batches) {
        stockByProduct.set(
            batch.productId,
            (stockByProduct.get(batch.productId) ?? 0) + batch.quantity,
        );
    }
    const sold = soldQuantityByProduct(sales);

    const items = products
        .map((product) => {
            const stock = product.totalStock ?? stockByProduct.get(product.id) ?? 0;
            const soldQuantity = sold.get(product.id) ?? 0;
            return {
                productId: product.id,
                productName: product.name,
                sku: product.sku,
                stock,
                minStock: product.minStock ?? 0,
                soldQuantity,
                ...reorderSuggestion({
                    stock,
                    minStock: product.minStock ?? 0,
                    soldQuantity,
                    windowDays,
                    coverDays,
                }),
            };
        })
        .filter((line) => line.suggestedQuantity > 0)
        .sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
            b.soldQuantity - a.soldQuantity)
        .slice(0, options.limit ?? 50);

    return { windowDays, coverDays, items };
};

/* -------------------------------------------------------------------------- */
/*  Clientes que regresan                                                     */
/* -------------------------------------------------------------------------- */

export interface RepeatCustomersReport {
    identifiedSales: number;
    anonymousSales: number;
    customers: number;
    repeatCustomers: number;
    /** Clientes con 2+ compras sobre los identificados, en porcentaje. */
    repeatRate: number;
    items: Array<{
        customerId: string;
        customerName: string | null;
        purchases: number;
        total: number;
        lastPurchaseAt: string;
    }>;
}

export const summarizeCustomers = (
    sales: Array<Pick<Sale, 'customerId' | 'customerName' | 'total'> & { createdAt: Date }>,
    limit = 20,
): RepeatCustomersReport => {
    const byCustomer = new Map<string, {
        customerName: string | null;
        purchases: number;
        cents: number;
        lastMs: number;
    }>();
    let anonymousSales = 0;
    for (const sale of sales) {
        if (!sale.customerId) {
            anonymousSales += 1;
            continue;
        }
        const entry = byCustomer.get(sale.customerId) ??
            { customerName: sale.customerName, purchases: 0, cents: 0, lastMs: 0 };
        entry.purchases += 1;
        entry.cents += toCents(sale.total);
        entry.lastMs = Math.max(entry.lastMs, sale.createdAt.getTime());
        entry.customerName = entry.customerName ?? sale.customerName;
        byCustomer.set(sale.customerId, entry);
    }

    const repeat = [...byCustomer.entries()].filter(([, entry]) => entry.purchases >= 2);
    return {
        identifiedSales: sales.length - anonymousSales,
        anonymousSales,
        customers: byCustomer.size,
        repeatCustomers: repeat.length,
        repeatRate: byCustomer.size
            ? Math.round((repeat.length / byCustomer.size) * 10000) / 100
            : 0,
        items: repeat
            .map(([customerId, entry]) => ({
                customerId,
                customerName: entry.customerName,
                purchases: entry.purchases,
                total: fromCents(entry.cents),
                lastPurchaseAt: new Date(entry.lastMs).toISOString(),
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, limit),
    };
};

export const getRepeatCustomers = async (filters: {
    from?: string;
    to?: string;
    limit?: number;
}): Promise<RepeatCustomersReport> => {
    const { items } = await salesRepo.listSales({ from: filters.from, to: filters.to });
    return summarizeCustomers(
        items.map((sale) => ({ ...sale, createdAt: sale.createdAt.toDate() })),
        filters.limit,
    );
};
