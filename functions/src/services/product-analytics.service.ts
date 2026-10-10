import * as auditRepo from '../repositories/audit-logs.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as entriesRepo from '../repositories/inventory-entries.repository';
import * as productsRepo from '../repositories/products.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as movementsRepo from '../repositories/stock-movements.repository';
import { Product, Sale, StockMovementType, isSaleProductItem } from '../types';
import { notFound } from '../utils/errors';
import { fromDate } from '../utils/firestore';
import { MemoryCache } from '../utils/memory-cache';
import { fromCents, toCents } from '../utils/taxes';
import { getZonedYmd, zonedStartOfDayMs } from '../utils/timezone';
import { REPORTS_TIME_ZONE } from './sales-reports.service';

/**
 * Análisis de un producto para decidir: ventas, precio, costo, stock y valor de
 * inventario, todo en **una** petición. Cada fuente se lee con un índice y una
 * cota (ver `getProductAnalytics`); el cálculo vive en `buildProductAnalytics`,
 * una función pura que se prueba sin Firestore.
 *
 * La comparativa contra productos de la misma base NO está aquí: el panel ya
 * tiene el catálogo completo en caché (`GET /products/sync`) y compararla ahí
 * cuesta cero lecturas.
 */

export const DEFAULT_ANALYTICS_MONTHS = 12;
export const MAX_ANALYTICS_MONTHS = 24;

/** Movimientos de stock que se leen como máximo para reconstruir la evolución. */
export const MOVEMENTS_CAP = 2000;
/** Entradas de mercancía recientes que se leen para el costo de compra. */
export const ENTRIES_LIMIT = 50;

const CACHE_TTL_MS = 60 * 1000;

interface TimestampLike {
    toMillis(): number;
}

/** Cambio de stock con signo por tipo de movimiento (ver `stockMovements`). */
const stockDelta = (type: StockMovementType, quantity: number): number => {
    switch (type) {
    case 'entry':
    case 'return_in':
    case 'adjustment_count':
        // `adjustment_count` ya viene con signo.
        return quantity;
    case 'sale_adjustment':
        // Venta: cantidad positiva descuenta; la anulación la guarda negativa.
        return -quantity;
    case 'exit_waste':
    case 'exit_expiry':
        return -quantity;
    default:
        return 0;
    }
};

// ---------------------------------------------------------------------------
// Meses locales de la farmacia
// ---------------------------------------------------------------------------

const monthOf = (ms: number): string =>
    getZonedYmd(ms, REPORTS_TIME_ZONE).slice(0, 7);

export const addMonths = (month: string, delta: number): string => {
    const [year, mon] = month.split('-').map(Number);
    const index = year * 12 + (mon - 1) + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

const monthStartMs = (month: string): number =>
    zonedStartOfDayMs(`${month}-01`, REPORTS_TIME_ZONE);

const monthRange = (from: string, to: string): string[] => {
    const months: string[] = [];
    for (let m = from; m <= to; m = addMonths(m, 1)) {
        months.push(m);
    }
    return months;
};

// ---------------------------------------------------------------------------
// Tipos de entrada (estructurales, para poder probar sin Firestore)
// ---------------------------------------------------------------------------

export interface AnalyticsInput {
    product: Pick<Product, 'id' | 'name' | 'salePrice' | 'minStock' | 'unit'> & {
        activeIngredient?: string | null;
        concentration?: string | null;
        totalStock?: number;
    };
    now: Date;
    months: number;
    sales: Array<Pick<Sale, 'items' | 'voidedAt'> & { createdAt: TimestampLike }>;
    returns: Array<{
        createdAt: TimestampLike;
        items: Array<{
            productId: string;
            quantity: number;
            refundAmount: number;
            taxes?: { base: number };
        }>;
    }>;
    movements: Array<{ type: StockMovementType; quantity: number; createdAt: TimestampLike }>;
    /** `true` si había más movimientos que `MOVEMENTS_CAP` (se leyeron los más recientes). */
    movementsTruncated: boolean;
    priceLogs: Array<{
        createdAt: TimestampLike;
        changes: Record<string, { before: unknown; after: unknown }> | null;
    }>;
    entries: Array<{
        id: string;
        supplierId: string;
        createdAt: TimestampLike;
        items: Array<{
            productId: string;
            quantity: number;
            costPrice?: number | null;
            lotNumber?: string;
        }>;
    }>;
    batches: Array<{
        quantity: number;
        costPrice?: number | null;
        expiryDate: TimestampLike;
    }>;
    /** Fuentes que no se pudieron leer (p. ej. índice aún en construcción). */
    unavailable?: string[];
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export interface SalesTotals {
    units: number;
    /** Cobrado con impuestos, neto de devoluciones. */
    revenue: number;
    /** Base sin impuestos, neta de devoluciones: sobre ella se calcula el margen. */
    base: number;
    cost: number;
    /** `null` cuando alguna venta no tenía costo capturado: no se inventa el margen. */
    margin: number | null;
    marginRate: number | null;
}

export interface MonthlyPoint extends SalesTotals {
    month: string;
    avgPrice: number | null;
    minPrice: number | null;
    maxPrice: number | null;
    /** Costo promedio de lo vendido (COGS / unidades con costo). */
    avgCostSold: number | null;
    /** Costo promedio ponderado de lo comprado en el mes. */
    avgCostPurchased: number | null;
    /** Precio de catálogo al cierre del mes (según cambios auditados). */
    catalogPrice: number;
    /** Stock al cierre del mes; `null` si el historial leído no alcanza. */
    endStock: number | null;
}

export interface ProductAnalytics {
    product: {
        id: string;
        name: string;
        unit: string;
        activeIngredient: string | null;
        concentration: string | null;
        minStock: number;
    };
    generatedAt: string;
    months: number;
    kpis: {
        currentPrice: number;
        lastPurchaseCost: number | null;
        stock: number;
        salesMonth: SalesTotals;
        salesYear: SalesTotals;
        inventory: {
            units: number;
            /** Σ cantidad × costo de los lotes con costo capturado. */
            costValue: number;
            /** Existencia × precio de catálogo (impuestos incluidos). */
            saleValue: number;
            unitsWithoutCost: number;
            batches: number;
            nextExpiry: string | null;
        };
    };
    monthly: MonthlyPoint[];
    priceChanges: Array<{ date: string; before: number; after: number }>;
    purchases: Array<{
        entryId: string;
        date: string;
        supplierId: string;
        lotNumber: string | null;
        quantity: number;
        costPrice: number | null;
    }>;
    truncated: { movements: boolean; entries: boolean };
    unavailable: string[];
}

// ---------------------------------------------------------------------------
// Cálculo puro
// ---------------------------------------------------------------------------

interface MonthAcc {
    units: number;
    netCents: number;
    baseCents: number;
    costCents: number;
    costUnits: number;
    uncosted: boolean;
    priceWeightCents: number;
    min: number | null;
    max: number | null;
    returnedUnits: number;
    returnedNetCents: number;
    returnedBaseCents: number;
    purchasedUnits: number;
    purchasedCostCents: number;
}

const emptyAcc = (): MonthAcc => ({
    units: 0,
    netCents: 0,
    baseCents: 0,
    costCents: 0,
    costUnits: 0,
    uncosted: false,
    priceWeightCents: 0,
    min: null,
    max: null,
    returnedUnits: 0,
    returnedNetCents: 0,
    returnedBaseCents: 0,
    purchasedUnits: 0,
    purchasedCostCents: 0,
});

const totalsOf = (accs: MonthAcc[]): SalesTotals => {
    const sum = (pick: (acc: MonthAcc) => number) =>
        accs.reduce((total, acc) => total + pick(acc), 0);
    const units = sum((a) => a.units) - sum((a) => a.returnedUnits);
    const baseCents = sum((a) => a.baseCents) - sum((a) => a.returnedBaseCents);
    const costCents = sum((a) => a.costCents);
    const uncosted = accs.some((a) => a.uncosted);
    const hasSales = accs.some((a) => a.units > 0);
    const margin = uncosted || !hasSales ? null : fromCents(baseCents - costCents);
    return {
        units,
        revenue: fromCents(sum((a) => a.netCents) - sum((a) => a.returnedNetCents)),
        base: fromCents(baseCents),
        cost: fromCents(costCents),
        margin,
        marginRate: margin === null || baseCents <= 0
            ? null
            : Math.round((margin / fromCents(baseCents)) * 10000) / 100,
    };
};

export const buildProductAnalytics = (input: AnalyticsInput): ProductAnalytics => {
    const { product, now, months } = input;
    const nowMs = now.getTime();
    const currentMonth = monthOf(nowMs);
    const currentYearStart = `${currentMonth.slice(0, 4)}-01`;
    const windowStart = addMonths(currentMonth, -(months - 1));
    // Hay que cubrir también el año en curso completo para "ventas del año".
    const firstMonth = windowStart < currentYearStart ? windowStart : currentYearStart;
    const allMonths = monthRange(firstMonth, currentMonth);
    const accs = new Map(allMonths.map((m) => [m, emptyAcc()]));

    // Ventas (anuladas fuera) -------------------------------------------------
    for (const sale of input.sales) {
        if (sale.voidedAt) {
            continue;
        }
        const acc = accs.get(monthOf(sale.createdAt.toMillis()));
        if (!acc) {
            continue;
        }
        for (const item of sale.items.filter(isSaleProductItem)) {
            if (item.productId !== product.id) {
                continue;
            }
            const netCents = toCents(item.netAmount ?? item.subtotal - item.discountAmount);
            acc.units += item.quantity;
            acc.netCents += netCents;
            acc.baseCents += item.taxes ? toCents(item.taxes.base) : netCents;
            acc.priceWeightCents += toCents(item.unitPrice) * item.quantity;
            acc.min = acc.min === null ? item.unitPrice : Math.min(acc.min, item.unitPrice);
            acc.max = acc.max === null ? item.unitPrice : Math.max(acc.max, item.unitPrice);
            if (item.costAmount === null || item.costAmount === undefined) {
                acc.uncosted = true;
            } else {
                acc.costCents += toCents(item.costAmount);
                acc.costUnits += item.quantity;
            }
        }
    }

    // Devoluciones: restan unidades e importe en el mes en que se devolvieron.
    // El costo no se ajusta (la devolución no guarda el COGS), así que el margen
    // de un mes con devoluciones queda ligeramente subestimado.
    for (const saleReturn of input.returns) {
        const acc = accs.get(monthOf(saleReturn.createdAt.toMillis()));
        if (!acc) {
            continue;
        }
        for (const item of saleReturn.items) {
            if (item.productId !== product.id) {
                continue;
            }
            acc.returnedUnits += item.quantity;
            acc.returnedNetCents += toCents(item.refundAmount);
            acc.returnedBaseCents += toCents(item.taxes?.base ?? item.refundAmount);
        }
    }

    // Compras (costo por entrada) ---------------------------------------------
    const purchases: ProductAnalytics['purchases'] = [];
    for (const entry of input.entries) {
        for (const item of entry.items) {
            if (item.productId !== product.id) {
                continue;
            }
            const costPrice = item.costPrice ?? null;
            purchases.push({
                entryId: entry.id,
                date: new Date(entry.createdAt.toMillis()).toISOString(),
                supplierId: entry.supplierId,
                lotNumber: item.lotNumber ?? null,
                quantity: item.quantity,
                costPrice,
            });
            const acc = accs.get(monthOf(entry.createdAt.toMillis()));
            if (acc && costPrice !== null) {
                acc.purchasedUnits += item.quantity;
                acc.purchasedCostCents += toCents(costPrice) * item.quantity;
            }
        }
    }
    purchases.sort((a, b) => b.date.localeCompare(a.date));
    const lastPurchaseCost = purchases.find((p) => p.costPrice !== null)?.costPrice ?? null;

    // Inventario actual --------------------------------------------------------
    const stocked = input.batches.filter((batch) => batch.quantity > 0);
    const batchUnits = stocked.reduce((total, batch) => total + batch.quantity, 0);
    const stock = Math.max(0, product.totalStock ?? batchUnits);
    const costValueCents = stocked.reduce(
        (total, batch) => batch.costPrice === null || batch.costPrice === undefined
            ? total
            : total + toCents(batch.costPrice) * batch.quantity,
        0,
    );
    const unitsWithoutCost = stocked
        .filter((batch) => batch.costPrice === null || batch.costPrice === undefined)
        .reduce((total, batch) => total + batch.quantity, 0);
    const nextExpiryMs = stocked.length
        ? Math.min(...stocked.map((batch) => batch.expiryDate.toMillis()))
        : null;

    // Precio de catálogo al cierre de cada mes ---------------------------------
    const priceChanges = input.priceLogs
        .flatMap((log) => {
            const change = log.changes?.salePrice;
            return change && typeof change.before === 'number' && typeof change.after === 'number'
                ? [{ ms: log.createdAt.toMillis(), before: change.before, after: change.after }]
                : [];
        })
        .sort((a, b) => a.ms - b.ms);
    const catalogPriceAt = (endMs: number): number => {
        const applied = priceChanges.filter((change) => change.ms < endMs);
        if (applied.length) {
            return applied[applied.length - 1].after;
        }
        return priceChanges.length ? priceChanges[0].before : product.salePrice;
    };

    // Stock al cierre de cada mes, hacia atrás desde la existencia actual ------
    const movementsDesc = [...input.movements].sort(
        (a, b) => b.createdAt.toMillis() - a.createdAt.toMillis(),
    );
    const oldestLoadedMs = input.movementsTruncated && movementsDesc.length
        ? movementsDesc[movementsDesc.length - 1].createdAt.toMillis()
        : null;
    const endStockAt = (endMs: number): number | null => {
        // Con el historial recortado solo se conocen los cierres posteriores al
        // movimiento más antiguo leído; antes de eso no se adivina.
        if (oldestLoadedMs !== null && endMs <= oldestLoadedMs) {
            return null;
        }
        const after = movementsDesc
            .filter((movement) => movement.createdAt.toMillis() >= endMs)
            .reduce((total, movement) => total + stockDelta(movement.type, movement.quantity), 0);
        return stock - after;
    };

    const monthly: MonthlyPoint[] = monthRange(windowStart, currentMonth).map((month) => {
        const acc = accs.get(month)!;
        const endMs = month === currentMonth ? nowMs + 1 : monthStartMs(addMonths(month, 1));
        const units = acc.units;
        return {
            month,
            ...totalsOf([acc]),
            avgPrice: units > 0 ? fromCents(Math.round(acc.priceWeightCents / units)) : null,
            minPrice: acc.min,
            maxPrice: acc.max,
            avgCostSold: acc.costUnits > 0
                ? fromCents(Math.round(acc.costCents / acc.costUnits))
                : null,
            avgCostPurchased: acc.purchasedUnits > 0
                ? fromCents(Math.round(acc.purchasedCostCents / acc.purchasedUnits))
                : null,
            catalogPrice: catalogPriceAt(endMs),
            endStock: endStockAt(endMs),
        };
    });

    const yearMonths = allMonths.filter((m) => m >= currentYearStart);
    return {
        product: {
            id: product.id,
            name: product.name,
            unit: product.unit,
            activeIngredient: product.activeIngredient ?? null,
            concentration: product.concentration ?? null,
            minStock: product.minStock,
        },
        generatedAt: now.toISOString(),
        months,
        kpis: {
            currentPrice: product.salePrice,
            lastPurchaseCost,
            stock,
            salesMonth: totalsOf([accs.get(currentMonth)!]),
            salesYear: totalsOf(yearMonths.map((m) => accs.get(m)!)),
            inventory: {
                units: batchUnits,
                costValue: fromCents(costValueCents),
                saleValue: fromCents(toCents(product.salePrice) * stock),
                unitsWithoutCost,
                batches: stocked.length,
                nextExpiry: nextExpiryMs === null ? null : new Date(nextExpiryMs).toISOString(),
            },
        },
        monthly,
        priceChanges: priceChanges.map((change) => ({
            date: new Date(change.ms).toISOString(),
            before: change.before,
            after: change.after,
        })),
        purchases,
        truncated: {
            movements: input.movementsTruncated,
            entries: input.entries.length >= ENTRIES_LIMIT,
        },
        unavailable: input.unavailable ?? [],
    };
};

// ---------------------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------------------

const cache = new MemoryCache<ProductAnalytics>(CACHE_TTL_MS, 100);

/**
 * Lecturas por llamada (todas por índice y acotadas):
 *  - 1 producto;
 *  - ventas del producto en la ventana: UNA consulta (`productIds
 *    array-contains` + `createdAt`) que sirve para mes, año, precio y costo;
 *  - devoluciones del producto (`array-contains` simple; son pocas);
 *  - ≤ `MOVEMENTS_CAP + 1` movimientos de stock (`productId, createdAt desc`);
 *  - cambios de precio auditados del producto;
 *  - ≤ `ENTRIES_LIMIT` entradas (`productIds array-contains, createdAt desc`);
 *  - lotes del producto.
 * El resultado se cachea 60 s por instancia.
 */
export const getProductAnalytics = async (
    productId: string,
    months: number = DEFAULT_ANALYTICS_MONTHS,
): Promise<ProductAnalytics> => {
    const cacheKey = `${productId}:${months}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const product = await productsRepo.getProductById(productId);
    if (!product) {
        throw notFound('Producto');
    }

    const now = new Date();
    const currentMonth = monthOf(now.getTime());
    const windowStart = addMonths(currentMonth, -(months - 1));
    const yearStart = `${currentMonth.slice(0, 4)}-01`;
    const sinceMs = monthStartMs(windowStart < yearStart ? windowStart : yearStart);
    const since = new Date(sinceMs);
    const unavailable: string[] = [];

    // El índice de entradas puede tardar en construirse tras un deploy: sin él
    // el análisis sigue (con el costo de ventas) en vez de fallar completo.
    const entries = await entriesRepo.listRecentEntriesByProduct(productId, ENTRIES_LIMIT)
        .catch(() => {
            unavailable.push('entries');
            return [];
        });

    const [sales, returns, movements, priceLogs, batches] = await Promise.all([
        salesRepo.listSalesByProductsBetween(
            [productId],
            fromDate(since),
            fromDate(new Date(now.getTime() + 1)),
        ),
        returnsRepo.listReturnsByProduct(productId),
        movementsRepo.listStockMovementsSince(productId, since, MOVEMENTS_CAP + 1),
        auditRepo.listAuditLogs({
            entityId: productId,
            entity: 'product',
            action: 'product.price_changed',
        }),
        batchesRepo.listBatchesByProduct(productId),
    ]);

    const result = buildProductAnalytics({
        product,
        now,
        months,
        sales,
        returns,
        movements: movements.slice(0, MOVEMENTS_CAP),
        movementsTruncated: movements.length > MOVEMENTS_CAP,
        priceLogs,
        entries,
        batches,
        unavailable,
    });
    cache.set(cacheKey, result);
    return result;
};
