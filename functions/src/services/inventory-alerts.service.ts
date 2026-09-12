import {
    ExpiringBatchAlert,
    InventoryAlerts,
    Product,
    StockAlert,
} from '../types';
import { now } from '../utils/firestore';
import * as batchesRepo from '../repositories/batches.repository';
import * as productsRepo from '../repositories/products.repository';

/** Ventanas de caducidad por omisión; son las que usa cualquier POS de farmacia. */
export const DEFAULT_EXPIRY_WINDOWS = [30, 60, 90];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (from: number, to: number): number =>
    Math.ceil((to - from) / MS_PER_DAY);

/**
 * Stock del producto: se prefiere `totalStock` denormalizado y se cae a sumar
 * lotes para documentos históricos (ver el pendiente de backfill en GOALS.md).
 */
const resolveStock = (product: Product, stockByProduct: Map<string, number>): number =>
    product.totalStock ?? stockByProduct.get(product.id) ?? 0;

export const getInventoryAlerts = async (options: {
    expiryWindows?: number[];
} = {}): Promise<InventoryAlerts> => {
    const windows = [...(options.expiryWindows ?? DEFAULT_EXPIRY_WINDOWS)]
        .filter((days) => Number.isInteger(days) && days > 0)
        .sort((a, b) => a - b);

    const [batches, products] = await Promise.all([
        batchesRepo.listBatchesWithStock(),
        productsRepo.listProducts({ activeOnly: true }),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const stockByProduct = new Map<string, number>();
    for (const batch of batches) {
        stockByProduct.set(
            batch.productId,
            (stockByProduct.get(batch.productId) ?? 0) + batch.quantity,
        );
    }

    const timestamp = now();
    const reference = timestamp.toMillis();

    const expired: ExpiringBatchAlert[] = [];
    const byWindow = new Map<number, ExpiringBatchAlert[]>(windows.map((days) => [days, []]));

    for (const batch of batches) {
        const product = productById.get(batch.productId);
        if (!product) {
            // Lote de un producto dado de baja: no se alerta, ya no se vende.
            continue;
        }

        const daysToExpiry = daysBetween(reference, batch.expiryDate.toMillis());
        const alert: ExpiringBatchAlert = {
            batchId: batch.id,
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            lotNumber: batch.lotNumber,
            expiryDate: batch.expiryDate,
            daysToExpiry,
            quantity: batch.quantity,
        };

        if (daysToExpiry <= 0) {
            expired.push(alert);
            continue;
        }
        // Cada lote cae en la ventana más chica que lo cubre, para no contarlo dos veces.
        const window = windows.find((days) => daysToExpiry <= days);
        if (window !== undefined) {
            byWindow.get(window)!.push(alert);
        }
    }

    const lowStock: StockAlert[] = [];
    const outOfStock: StockAlert[] = [];
    const unstocked: StockAlert[] = [];

    for (const product of products) {
        const totalStock = resolveStock(product, stockByProduct);
        const alert: StockAlert = {
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            minStock: product.minStock,
            totalStock,
        };

        /**
         * El mínimo es lo que separa un faltante de una ficha de catálogo.
         *
         * `outOfStock` no exigía `minStock > 0` —`lowStock` sí— y por eso
         * recogía **todo** producto activo que hoy estuviera en cero: 211 en
         * producción contra media docena de faltantes reales. Un producto con
         * mínimo 0 y stock 0 no es una alerta: nadie declaró que debiera estar
         * en existencia. Enterraba lo accionable y entrenaba al personal a
         * ignorar el aviso diario.
         */
        if (totalStock <= 0) {
            (product.minStock > 0 ? outOfStock : unstocked).push(alert);
        } else if (product.minStock > 0 && totalStock <= product.minStock) {
            lowStock.push(alert);
        }
    }

    const expiring = windows.map((windowDays) => ({
        windowDays,
        items: byWindow.get(windowDays)!.sort((a, b) => a.daysToExpiry - b.daysToExpiry),
    }));

    const expiringItems = expiring.flatMap((entry) => entry.items);
    const sumUnits = (items: ExpiringBatchAlert[]) =>
        items.reduce((total, item) => total + item.quantity, 0);

    return {
        generatedAt: timestamp,
        expired: expired.sort((a, b) => a.daysToExpiry - b.daysToExpiry),
        expiring,
        lowStock: lowStock.sort((a, b) => a.totalStock - b.totalStock),
        // Por mínimo descendente: lo que más falta primero. Alfabético ponía
        // arriba lo que empieza con A, no lo que urge.
        outOfStock: outOfStock.sort((a, b) => b.minStock - a.minStock),
        // Alfabético sí: es una lista para depurar catálogo, no para actuar.
        unstocked: unstocked.sort((a, b) => a.productName.localeCompare(b.productName)),
        totals: {
            expiredBatches: expired.length,
            expiredUnits: sumUnits(expired),
            expiringBatches: expiringItems.length,
            expiringUnits: sumUnits(expiringItems),
            lowStockProducts: lowStock.length,
            outOfStockProducts: outOfStock.length,
            unstockedProducts: unstocked.length,
        },
    };
};

/**
 * ¿Vale la pena mandar el correo? Sin nada que reportar, no se manda.
 *
 * `unstocked` **no** cuenta: el catálogo en cero no cambia de un día para otro
 * y bastaba para disparar el correo todos los días con nada que hacer, que es
 * justo cómo una alerta deja de leerse.
 */
export const hasActionableAlerts = (alerts: InventoryAlerts): boolean =>
    alerts.totals.expiredBatches > 0 ||
    alerts.totals.expiringBatches > 0 ||
    alerts.totals.lowStockProducts > 0 ||
    alerts.totals.outOfStockProducts > 0;
