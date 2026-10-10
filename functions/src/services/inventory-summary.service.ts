import { Product, Sale, isSaleProductItem } from '../types';
import { fromCents, resolveIepsRate, resolveIvaRate, toCents } from '../utils/taxes';
import * as batchesRepo from '../repositories/batches.repository';
import * as categoriesRepo from '../repositories/categories.repository';
import * as productsRepo from '../repositories/products.repository';
import * as salesRepo from '../repositories/sales.repository';
import { ExpiryBucket, expiryBucketOf } from './insights.service';

/**
 * Foto del inventario para quien decide compras: cuánto dinero hay en anaquel
 * (a costo y a precio de venta), cuánto rinde, qué tan rápido rota y cuánto está
 * en riesgo por caducidad o por no venderse. Todo a hoy; la regla de cálculo es
 * una función pura y lo que lee Firestore solo arma sus entradas.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;
const TOP_PRODUCTS = 10;
const EXPIRY_BUCKETS: ExpiryBucket[] = ['expired', 'days30', 'days60', 'days90'];

export interface InventorySummaryBatch {
    productId: string;
    quantity: number;
    costPrice?: number;
    expiryDate: Date;
}

export interface InventoryValueLine {
    units: number;
    cost: number;
    retail: number;
}

export interface InventorySummary {
    asOf: string;
    windowDays: number;
    valuation: {
        /** Existencia × costo del lote; los lotes sin costo no suman. */
        cost: number;
        /** Existencia × precio al público, impuestos incluidos. */
        retail: number;
        /** Lo mismo sin IVA ni IEPS: es la base contra la que se compara el costo. */
        retailBase: number;
        /** Base de venta menos costo, solo sobre lotes con costo. */
        potentialProfit: number;
        /** `potentialProfit` sobre la base de venta de los lotes con costo, en %. */
        potentialMarginRate: number;
        batchesWithoutCost: number;
        unitsWithoutCost: number;
    };
    stock: {
        units: number;
        batches: number;
        activeProducts: number;
        productsWithStock: number;
        outOfStock: number;
        lowStock: number;
    };
    turnover: {
        /** Costo de lo vendido en la ventana. */
        soldCost: number;
        /** Días que dura el inventario a costo al ritmo de la ventana; `null` sin ventas. */
        daysOfInventory: number | null;
        /** Vueltas al año del inventario a costo; `null` sin inventario o sin ventas. */
        annualTurnover: number | null;
    };
    expiry: Array<{ bucket: ExpiryBucket; batches: number; units: number; cost: number }>;
    /** Con existencia y sin una sola venta en la ventana: dinero detenido. */
    deadStock: { products: number; units: number; cost: number };
    byCategory: Array<InventoryValueLine & {
        categoryId: string;
        categoryName: string;
        /** Parte del inventario a costo, en %. */
        share: number;
    }>;
    /** Productos con más dinero inmovilizado a costo. */
    topProducts: Array<InventoryValueLine & {
        productId: string;
        name: string;
        sku: string;
        /** Días que alcanza la existencia al ritmo de la ventana; `null` si no se vendió. */
        daysOfCover: number | null;
    }>;
}

interface ProductTotals {
    units: number;
    costCents: number;
    retailCents: number;
}

const rate = (part: number, whole: number): number =>
    whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0;

const round1 = (value: number): number => Math.round(value * 10) / 10;

const baseCentsOf = (product: Product, grossCents: number): number =>
    Math.round(grossCents / ((1 + resolveIepsRate(product)) * (1 + resolveIvaRate(product))));

export const summarizeInventory = (input: {
    products: Product[];
    batches: InventorySummaryBatch[];
    categoryNames: Map<string, string>;
    sales: Sale[];
    windowDays: number;
    asOf: Date;
}): InventorySummary => {
    const { products, batches, categoryNames, sales, windowDays, asOf } = input;
    const productById = new Map(products.map((product) => [product.id, product]));

    const soldUnits = new Map<string, number>();
    let soldCostCents = 0;
    for (const sale of sales) {
        for (const item of sale.items.filter(isSaleProductItem)) {
            soldUnits.set(item.productId, (soldUnits.get(item.productId) ?? 0) + item.quantity);
            soldCostCents += toCents(item.costAmount ?? 0);
        }
    }

    const totals = new Map<string, ProductTotals>();
    const expiry = new Map(EXPIRY_BUCKETS.map((bucket) => [
        bucket,
        { batches: 0, units: 0, costCents: 0 },
    ]));
    let costCents = 0;
    let retailCents = 0;
    let retailBaseCents = 0;
    let valuedBaseCents = 0;
    let units = 0;
    let batchCount = 0;
    let batchesWithoutCost = 0;
    let unitsWithoutCost = 0;

    for (const batch of batches) {
        if (batch.quantity <= 0) {
            continue;
        }
        const product = productById.get(batch.productId);
        const hasCost = batch.costPrice !== undefined && batch.costPrice !== null;
        const batchCostCents = hasCost ? toCents(batch.costPrice!) * batch.quantity : 0;
        const batchRetailCents = product ? toCents(product.salePrice) * batch.quantity : 0;
        const batchBaseCents = product ? baseCentsOf(product, batchRetailCents) : 0;

        batchCount += 1;
        units += batch.quantity;
        costCents += batchCostCents;
        retailCents += batchRetailCents;
        retailBaseCents += batchBaseCents;
        if (hasCost) {
            valuedBaseCents += batchBaseCents;
        } else {
            batchesWithoutCost += 1;
            unitsWithoutCost += batch.quantity;
        }

        const entry = totals.get(batch.productId) ?? { units: 0, costCents: 0, retailCents: 0 };
        entry.units += batch.quantity;
        entry.costCents += batchCostCents;
        entry.retailCents += batchRetailCents;
        totals.set(batch.productId, entry);

        const daysToExpiry = Math.floor((batch.expiryDate.getTime() - asOf.getTime()) / MS_PER_DAY);
        const bucket = expiryBucketOf(daysToExpiry);
        if (bucket) {
            const slot = expiry.get(bucket)!;
            slot.batches += 1;
            slot.units += batch.quantity;
            slot.costCents += batchCostCents;
        }
    }

    const activeProducts = products.filter((product) => product.isActive);
    const stockOf = (productId: string): number => totals.get(productId)?.units ?? 0;
    const lowStock = activeProducts.filter((product) => {
        const stock = stockOf(product.id);
        return stock > 0 && stock <= (product.minStock ?? 0);
    }).length;

    const dead = { products: 0, units: 0, costCents: 0 };
    for (const [productId, entry] of totals) {
        if (!soldUnits.has(productId)) {
            dead.products += 1;
            dead.units += entry.units;
            dead.costCents += entry.costCents;
        }
    }

    const byCategory = new Map<string, ProductTotals>();
    for (const [productId, entry] of totals) {
        const categoryId = productById.get(productId)?.categoryId ?? '';
        const line = byCategory.get(categoryId) ?? { units: 0, costCents: 0, retailCents: 0 };
        line.units += entry.units;
        line.costCents += entry.costCents;
        line.retailCents += entry.retailCents;
        byCategory.set(categoryId, line);
    }

    const dailySoldCents = windowDays > 0 ? soldCostCents / windowDays : 0;
    const potentialProfitCents = valuedBaseCents - costCents;

    return {
        asOf: asOf.toISOString(),
        windowDays,
        valuation: {
            cost: fromCents(costCents),
            retail: fromCents(retailCents),
            retailBase: fromCents(retailBaseCents),
            potentialProfit: fromCents(potentialProfitCents),
            potentialMarginRate: rate(potentialProfitCents, valuedBaseCents),
            batchesWithoutCost,
            unitsWithoutCost,
        },
        stock: {
            units,
            batches: batchCount,
            activeProducts: activeProducts.length,
            productsWithStock: totals.size,
            outOfStock: activeProducts.filter((product) => stockOf(product.id) === 0).length,
            lowStock,
        },
        turnover: {
            soldCost: fromCents(soldCostCents),
            daysOfInventory: dailySoldCents > 0 ? round1(costCents / dailySoldCents) : null,
            annualTurnover: dailySoldCents > 0 && costCents > 0
                ? Math.round(((dailySoldCents * 365) / costCents) * 100) / 100
                : null,
        },
        expiry: EXPIRY_BUCKETS.map((bucket) => {
            const slot = expiry.get(bucket)!;
            return {
                bucket,
                batches: slot.batches,
                units: slot.units,
                cost: fromCents(slot.costCents),
            };
        }),
        deadStock: { products: dead.products, units: dead.units, cost: fromCents(dead.costCents) },
        byCategory: [...byCategory.entries()]
            .map(([categoryId, line]) => ({
                categoryId,
                categoryName: categoryNames.get(categoryId) ?? 'Sin categoría',
                units: line.units,
                cost: fromCents(line.costCents),
                retail: fromCents(line.retailCents),
                share: rate(line.costCents, costCents),
            }))
            .sort((a, b) => b.cost - a.cost || b.retail - a.retail),
        topProducts: [...totals.entries()]
            .sort(([, a], [, b]) => b.costCents - a.costCents || b.retailCents - a.retailCents)
            .slice(0, TOP_PRODUCTS)
            .map(([productId, entry]) => {
                const product = productById.get(productId);
                const sold = soldUnits.get(productId) ?? 0;
                const dailyUnits = windowDays > 0 ? sold / windowDays : 0;
                return {
                    productId,
                    name: product?.name ?? productId,
                    sku: product?.sku ?? '',
                    units: entry.units,
                    cost: fromCents(entry.costCents),
                    retail: fromCents(entry.retailCents),
                    daysOfCover: dailyUnits > 0 ? round1(entry.units / dailyUnits) : null,
                };
            }),
    };
};

export const getInventorySummary = async (
    options: { windowDays?: number } = {},
): Promise<InventorySummary> => {
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const asOf = new Date();
    const [products, batches, categories, { items: sales }] = await Promise.all([
        productsRepo.listProducts({ activeOnly: false }),
        batchesRepo.listBatchesWithStock(),
        categoriesRepo.listCategories({}),
        salesRepo.listSales({
            from: new Date(asOf.getTime() - windowDays * MS_PER_DAY).toISOString(),
            to: asOf.toISOString(),
        }),
    ]);

    return summarizeInventory({
        products,
        batches: batches.map((batch) => ({ ...batch, expiryDate: batch.expiryDate.toDate() })),
        categoryNames: new Map(categories.items.map((category) => [category.id, category.name])),
        sales,
        windowDays,
        asOf,
    });
};
