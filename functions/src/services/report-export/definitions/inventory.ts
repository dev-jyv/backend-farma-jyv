import * as batchesRepo from '../../../repositories/batches.repository';
import * as countsRepo from '../../../repositories/inventory-counts.repository';
import * as productsRepo from '../../../repositories/products.repository';
import * as movementsRepo from '../../../repositories/stock-movements.repository';
import { StockMovementType } from '../../../types';
import { formatCurrency } from '../../../utils/currency';
import { fromCents, toCents } from '../../../utils/taxes';
import { getDeadStock } from '../../analytics.service';
import { getExpiryReport, getReorderSuggestions, ExpiryBucket } from '../../insights.service';
import { getInventorySummary } from '../../inventory-summary.service';
import {
    NO_CASHIER,
    buildInventoryRows,
    buildLowStockRows,
    buildNoCostRows,
    resolveUserNames,
    todayYmd,
} from '../../module-reports.service';
import { ReportDefinition } from '../report-definition';
import { resolveReportPeriod } from '../period';
import { MAX_ROWS, stampDate, stampTime, ymdToDisplay } from './shared';

const today = (now: Date): string => ymdToDisplay(todayYmd(now));

export const inventario: ReportDefinition = {
    key: 'inventario',
    title: 'Existencias valoradas',
    columns: [
        { key: 'name', header: 'Producto', type: 'text' },
        { key: 'sku', header: 'SKU', type: 'text' },
        { key: 'stock', header: 'Existencia', type: 'int', total: true },
        { key: 'minStock', header: 'Mínimo', type: 'int' },
        { key: 'costValue', header: 'Valor a costo', type: 'money', total: true },
        { key: 'retailValue', header: 'Valor a precio de venta', type: 'money', total: true },
        { key: 'missingCost', header: 'Lote sin costo', type: 'text' },
    ],
    load: async ({ now }) => {
        const [products, batches] = await Promise.all([
            productsRepo.listProducts({ activeOnly: true }),
            batchesRepo.listBatchesWithStock(),
        ]);
        return {
            subtitle: `Existencias al ${today(now)}`,
            slug: todayYmd(now),
            rows: buildInventoryRows(products, batches).map(({ missingCost, ...row }) => ({
                ...row,
                missingCost: missingCost ? 'Sí' : '',
            })),
            emptyMessage: 'No hay productos activos.',
            notes: ['Donde un lote no tiene costo capturado, el valor a costo queda corto.'],
        };
    },
};

export const existenciasCategoria: ReportDefinition = {
    key: 'existencias-categoria',
    title: 'Existencias por categoría',
    columns: [
        { key: 'category', header: 'Categoría', type: 'text' },
        { key: 'units', header: 'Unidades', type: 'int', total: true },
        { key: 'cost', header: 'Valor a costo', type: 'money', total: true },
        { key: 'retail', header: 'Valor a precio de venta', type: 'money', total: true },
        { key: 'share', header: 'Parte del inventario', type: 'percent' },
    ],
    load: async ({ now }) => {
        const summary = await getInventorySummary();
        return {
            subtitle: `Existencias al ${today(now)}`,
            slug: todayYmd(now),
            rows: summary.byCategory.map((line) => ({
                category: line.categoryName,
                units: line.units,
                cost: line.cost,
                retail: line.retail,
                share: line.share,
            })),
            emptyMessage: 'No hay existencias.',
            notes: [
                `Inventario a costo ${formatCurrency(summary.valuation.cost)}; utilidad potencial `
                + `${formatCurrency(summary.valuation.potentialProfit)} `
                + `(${summary.valuation.potentialMarginRate.toFixed(2)}%).`,
                `${summary.valuation.batchesWithoutCost} lotes sin costo no suman al valor `
                + 'a costo.',
            ],
        };
    },
};

export const stockBajo: ReportDefinition = {
    key: 'stock-bajo',
    title: 'Stock bajo',
    columns: [
        { key: 'name', header: 'Producto', type: 'text' },
        { key: 'sku', header: 'SKU', type: 'text' },
        { key: 'stock', header: 'Existencia', type: 'int', total: true },
        { key: 'minStock', header: 'Mínimo', type: 'int' },
        { key: 'missing', header: 'Faltante', type: 'int', total: true },
        { key: 'status', header: 'Estado', type: 'text' },
    ],
    load: async ({ now }) => {
        const [products, batches] = await Promise.all([
            productsRepo.listProducts({ activeOnly: true }),
            batchesRepo.listBatchesWithStock(),
        ]);
        return {
            subtitle: `Productos en o bajo su mínimo al ${today(now)}`,
            slug: todayYmd(now),
            rows: buildLowStockRows(products, batches).map((row) => ({
                name: row.name,
                sku: row.sku,
                stock: row.stock,
                minStock: row.minStock,
                missing: row.missing,
                status: row.stock === 0 ? 'Agotado' : 'Bajo',
            })),
            emptyMessage: 'Ningún producto activo está en o bajo su mínimo.',
        };
    },
};

const EXPIRY_LABELS: Record<ExpiryBucket, string> = {
    expired: 'Vencido',
    days30: '0 a 30 días',
    days60: '31 a 60 días',
    days90: '61 a 90 días',
};

export const caducidad: ReportDefinition = {
    key: 'caducidad',
    title: 'Caducidades',
    columns: [
        { key: 'product', header: 'Producto', type: 'text' },
        { key: 'lot', header: 'Lote', type: 'text' },
        { key: 'expiry', header: 'Caduca', type: 'text' },
        { key: 'days', header: 'Días', type: 'int' },
        { key: 'quantity', header: 'Cantidad', type: 'int', total: true },
        { key: 'value', header: 'Valor a costo', type: 'money', total: true },
        { key: 'status', header: 'Estado', type: 'text' },
    ],
    load: async ({ now }) => {
        const report = await getExpiryReport({ limit: 100000 });
        return {
            subtitle: `Lotes con existencia vencidos o que caducan en 90 días, al ${today(now)}`,
            slug: todayYmd(now),
            rows: report.items.map((item) => ({
                product: item.productName,
                lot: item.lotNumber,
                expiry: ymdToDisplay(item.expiryDate),
                days: item.daysToExpiry,
                quantity: item.quantity,
                value: item.value,
                status: EXPIRY_LABELS[item.bucket],
            })),
            emptyMessage: 'Ningún lote con existencia caduca en los próximos 90 días.',
            notes: [
                'Días negativos: el lote ya venció. El valor es cantidad por costo del lote.',
                `${report.batchesWithoutCost} lotes sin costo capturado cuentan como valor cero.`,
            ],
        };
    },
};

export const sinCosto: ReportDefinition = {
    key: 'sin-costo',
    title: 'Productos sin costo',
    columns: [
        { key: 'name', header: 'Producto', type: 'text' },
        { key: 'sku', header: 'SKU', type: 'text' },
        { key: 'stock', header: 'Existencia', type: 'int', total: true },
        { key: 'unitsWithoutCost', header: 'Unidades sin costo', type: 'int', total: true },
        { key: 'lotsWithoutCost', header: 'Lotes sin costo', type: 'int', total: true },
        { key: 'salePrice', header: 'Precio de venta', type: 'money' },
    ],
    load: async ({ now }) => {
        const [products, batches] = await Promise.all([
            productsRepo.listProducts({ activeOnly: true }),
            batchesRepo.listBatchesWithStock(),
        ]);
        return {
            subtitle: 'Productos con existencia cuyo lote no tiene costo capturado',
            slug: todayYmd(now),
            rows: buildNoCostRows(products, batches).map((row) => ({ ...row })),
            emptyMessage: 'Todos los lotes con existencia tienen costo capturado.',
            notes: ['Sin costo capturado la utilidad y el margen de estos productos '
                + 'salen inflados.'],
        };
    },
};

export const sinMovimiento: ReportDefinition = {
    key: 'sin-movimiento',
    title: 'Productos sin movimiento',
    columns: [
        { key: 'name', header: 'Producto', type: 'text' },
        { key: 'sku', header: 'SKU', type: 'text' },
        { key: 'stock', header: 'Existencia', type: 'int', total: true },
        { key: 'last', header: 'Última salida', type: 'text' },
        { key: 'days', header: 'Días sin salida', type: 'int' },
    ],
    load: async ({ query, now }) => {
        const days = query.days ?? 90;
        const report = await getDeadStock({ days, limit: MAX_ROWS });
        return {
            subtitle: `Con existencia y sin salida en ${days} días, al ${today(now)}`,
            slug: `${days}d-${todayYmd(now)}`,
            rows: report.items.map((item) => ({
                name: item.productName,
                sku: item.sku,
                stock: item.totalStock,
                last: item.lastMovementAt ? ymdToDisplay(item.lastMovementAt) : 'Sin salidas',
                days: item.daysWithoutMovement,
            })),
            emptyMessage: 'Todos los productos con existencia tuvieron salidas en la ventana.',
            notes: ['Solo cuentan salidas (venta, merma, caducidad): una compra reciente no '
                + 'significa que el producto se venda.'],
        };
    },
};

const WASTE_LABELS: Partial<Record<StockMovementType, string>> = {
    exit_waste: 'Merma',
    exit_expiry: 'Caducidad',
};

export const mermas: ReportDefinition = {
    key: 'mermas',
    title: 'Mermas y caducados',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'time', header: 'Hora', type: 'text' },
        { key: 'product', header: 'Producto', type: 'text' },
        { key: 'sku', header: 'SKU', type: 'text' },
        { key: 'lot', header: 'Lote', type: 'text' },
        { key: 'type', header: 'Tipo', type: 'text' },
        { key: 'quantity', header: 'Cantidad', type: 'int', total: true },
        { key: 'unitCost', header: 'Costo unitario', type: 'money' },
        { key: 'cost', header: 'Costo total', type: 'money', total: true },
        { key: 'reason', header: 'Motivo', type: 'text' },
        { key: 'createdBy', header: 'Registró', type: 'text' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const bounds = { from: range.from, to: range.to };
        const [waste, expiry, products] = await Promise.all([
            movementsRepo.listStockMovements({ type: 'exit_waste', ...bounds }),
            movementsRepo.listStockMovements({ type: 'exit_expiry', ...bounds }),
            productsRepo.listProducts({ activeOnly: false }),
        ]);
        const movements = [...waste, ...expiry]
            .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
        const batchIds = [...new Set(movements.map((movement) => movement.batchId))];
        const [batches, names] = await Promise.all([
            Promise.all(batchIds.map((id) => batchesRepo.getBatchById(id))),
            resolveUserNames(movements.map((movement) => movement.userId)),
        ]);
        const batchById = new Map(batchIds.map((id, index) => [id, batches[index]]));
        const productById = new Map(products.map((product) => [product.id, product]));

        let withoutCost = 0;
        const rows = movements.map((movement) => {
            const batch = batchById.get(movement.batchId);
            const product = productById.get(movement.productId);
            const quantity = Math.abs(movement.quantity);
            const unitCost = batch?.costPrice ?? null;
            if (unitCost === null) {
                withoutCost += 1;
            }
            return {
                date: stampDate(movement.createdAt),
                time: stampTime(movement.createdAt),
                product: product?.name ?? movement.productId,
                sku: product?.sku ?? '',
                lot: batch?.lotNumber ?? '',
                type: WASTE_LABELS[movement.type] ?? movement.type,
                quantity,
                unitCost,
                cost: unitCost === null ? null : fromCents(toCents(unitCost) * quantity),
                reason: movement.reason ?? '',
                createdBy: names.get(movement.userId) ?? NO_CASHIER,
            };
        });
        const notes = ['El costo es el del lote al momento del reporte.'];
        if (withoutCost > 0) {
            notes.push(`${withoutCost} salidas sin costo capturado no suman al costo total.`);
        }
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            notes,
            emptyMessage: 'Sin mermas en el periodo.',
        };
    },
};

export const reabasto: ReportDefinition = {
    key: 'reabasto',
    title: 'Reabasto sugerido',
    columns: [
        { key: 'name', header: 'Producto', type: 'text' },
        { key: 'sku', header: 'SKU', type: 'text' },
        { key: 'stock', header: 'Existencia', type: 'int' },
        { key: 'minStock', header: 'Mínimo', type: 'int' },
        { key: 'sold', header: 'Vendido (30 días)', type: 'int' },
        { key: 'daily', header: 'Promedio diario', type: 'decimal' },
        { key: 'cover', header: 'Días de cobertura', type: 'decimal' },
        { key: 'suggested', header: 'Sugerido a pedir', type: 'int', total: true },
    ],
    load: async ({ now }) => {
        const report = await getReorderSuggestions({ limit: MAX_ROWS });
        return {
            subtitle: `Ventana de ${report.windowDays} días, `
                + `cobertura de ${report.coverDays} días, al ${today(now)}`,
            slug: todayYmd(now),
            rows: report.items.map((item) => ({
                name: item.productName,
                sku: item.sku,
                stock: item.stock,
                minStock: item.minStock,
                sold: item.soldQuantity,
                daily: item.averageDaily,
                cover: item.daysOfCover,
                suggested: item.suggestedQuantity,
            })),
            emptyMessage: 'No hay productos que resurtir.',
            notes: ['Es una sugerencia: la compra la decide quien compra.'],
        };
    },
};

export const conteos: ReportDefinition = {
    key: 'conteos',
    title: 'Conteos físicos',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'folio', header: 'Folio', type: 'text' },
        { key: 'items', header: 'Lotes contados', type: 'int', total: true },
        { key: 'positive', header: 'Unidades de más', type: 'int', total: true },
        { key: 'negative', header: 'Unidades de menos', type: 'int', total: true },
        { key: 'createdBy', header: 'Registró', type: 'text' },
        { key: 'notes', header: 'Notas', type: 'text' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const counts = await countsRepo.listInventoryCounts({ from: range.from, to: range.to });
        const names = await resolveUserNames(counts.map((count) => count.createdBy));
        const rows = [...counts]
            .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
            .map((count) => ({
                date: `${stampDate(count.createdAt)} ${stampTime(count.createdAt)}`,
                folio: count.folio,
                items: count.items.length,
                positive: count.positiveUnits,
                negative: count.negativeUnits,
                createdBy: names.get(count.createdBy) ?? NO_CASHIER,
                notes: count.notes ?? '',
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin conteos físicos en el periodo.',
            notes: ['Un conteo ajusta la existencia; no se registra como merma.'],
        };
    },
};

export const inventoryDefinitions: ReportDefinition[] = [
    inventario,
    existenciasCategoria,
    stockBajo,
    caducidad,
    sinCosto,
    sinMovimiento,
    mermas,
    reabasto,
    conteos,
];
