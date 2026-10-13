import * as batchesRepo from '../repositories/batches.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as productsRepo from '../repositories/products.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';
import * as usersRepo from '../repositories/users.repository';
import { Sale, isSaleProductItem, isSaleServiceItem } from '../types';
import { formatCurrency } from '../utils/currency';
import { fromCents, toCents } from '../utils/taxes';
import { addDaysYmd, getZonedYmd, zonedStartOfDayMs } from '../utils/timezone';
import { addMonths, monthStartMs } from './product-analytics.service';
import { renderHtmlToPdf } from './report-pdf.service';
import { PAYMENT_METHOD_LABELS, REPORTS_TIME_ZONE } from './sales-reports.service';

/**
 * PDFs del módulo de Reportes (farmacia, consultorio y financiero). Cada archivo
 * dice quién lo generó y cuándo; cada venta lista quién la cobró y a qué hora.
 *
 * `scope` decide qué partidas cuentan: `pharmacy` solo mercancía, `clinic` solo
 * servicios y `financial` la venta completa. Una venta mixta aparece en las dos
 * ramas con el importe de su parte, no con el total del ticket.
 */

export type ReportScope = 'pharmacy' | 'clinic' | 'financial';

const SCOPE_TITLES: Record<ReportScope, string> = {
    pharmacy: 'Farmacia',
    clinic: 'Consultorio',
    financial: 'Financiero',
};

const NO_CASHIER = 'Sin identificar';
const MAX_CONCEPT_ITEMS = 6;

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
    hour12: true,
});
const longDayFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: REPORTS_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
});
const monthFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
});

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/* -------------------------------------------------------------------------- */
/*  Periodos                                                                  */
/* -------------------------------------------------------------------------- */

export interface ReportRange {
    from: string;
    to: string;
    label: string;
    /** Parte de un nombre de archivo: `2026-10-13` o `2026-10`. */
    slug: string;
}

export const todayYmd = (now = new Date()): string => getZonedYmd(now.getTime(), REPORTS_TIME_ZONE);
export const currentMonth = (now = new Date()): string => todayYmd(now).slice(0, 7);

export const dayRange = (ymd: string): ReportRange => ({
    from: new Date(zonedStartOfDayMs(ymd, REPORTS_TIME_ZONE)).toISOString(),
    to: new Date(zonedStartOfDayMs(addDaysYmd(ymd, 1), REPORTS_TIME_ZONE) - 1).toISOString(),
    label: longDayFormatter.format(new Date(zonedStartOfDayMs(ymd, REPORTS_TIME_ZONE) + 12 * 3600 * 1000)),
    slug: ymd,
});

export const monthRange = (month: string): ReportRange => {
    const [year, mon] = month.split('-').map(Number);
    return {
        from: new Date(monthStartMs(month)).toISOString(),
        to: new Date(monthStartMs(addMonths(month, 1)) - 1).toISOString(),
        label: monthFormatter.format(new Date(Date.UTC(year, mon - 1, 1))),
        slug: month,
    };
};

/* -------------------------------------------------------------------------- */
/*  Ventas                                                                    */
/* -------------------------------------------------------------------------- */

export interface SalesPdfRow {
    date: string;
    time: string;
    folio: string;
    cashier: string;
    payment: string;
    concept: string;
    amount: number;
}

const netCentsOf = (item: { netAmount?: number; subtotal: number; discountAmount: number }): number =>
    toCents(item.netAmount ?? item.subtotal - item.discountAmount);

const joinConcepts = (parts: string[]): string =>
    parts.length > MAX_CONCEPT_ITEMS
        ? `${parts.slice(0, MAX_CONCEPT_ITEMS).join(', ')} y ${parts.length - MAX_CONCEPT_ITEMS} más`
        : parts.join(', ');

/**
 * Una fila por venta con lo que cuenta para el ámbito. Las anuladas no entran y
 * una venta sin partidas del ámbito (p. ej. solo servicios en farmacia) se omite.
 * Orden cronológico.
 */
export const buildSalesRows = (
    sales: readonly Sale[],
    scope: ReportScope,
    cashierNames: ReadonlyMap<string, string>,
): SalesPdfRow[] =>
    [...sales]
        .filter((sale) => !sale.voidedAt)
        .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
        .flatMap((sale) => {
            const products = sale.items.filter(isSaleProductItem);
            const services = sale.items.filter(isSaleServiceItem);
            const productPart = products.map((item) => `${item.quantity}× ${item.productName}`);
            const servicePart = services.map((item) =>
                `${item.quantity > 1 ? `${item.quantity}× ` : ''}${item.serviceName}` +
                (item.providerName ? ` (${item.providerName})` : ''));

            let concepts: string[];
            let amount: number;
            if (scope === 'pharmacy') {
                concepts = productPart;
                amount = fromCents(products.reduce((total, item) => total + netCentsOf(item), 0));
            } else if (scope === 'clinic') {
                concepts = servicePart;
                amount = fromCents(services.reduce((total, item) => total + netCentsOf(item), 0));
            } else {
                concepts = [...productPart, ...servicePart];
                amount = sale.total;
            }
            if (concepts.length === 0) {
                return [];
            }

            const at = sale.createdAt.toDate();
            return [{
                date: dateFormatter.format(at),
                time: timeFormatter.format(at),
                folio: sale.folio,
                cashier: cashierNames.get(sale.cashierId) ?? NO_CASHIER,
                payment: PAYMENT_METHOD_LABELS[sale.paymentMethod] ?? sale.paymentMethod,
                concept: joinConcepts(concepts),
                amount,
            }];
        });

const STYLES = `
<style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #1f2937; font-size: 11px; margin: 0; }
    h1 { font-size: 20px; margin: 0 0 2px; color: #0f5132; }
    .sub { color: #4b5563; margin: 0 0 2px; font-size: 12px; text-transform: capitalize; }
    .meta { color: #6b7280; margin: 0 0 14px; font-size: 10px; }
    h2 { font-size: 13px; margin: 16px 0 6px; color: #0f5132; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #0f5132; color: #fff; text-align: left; padding: 5px 6px; font-size: 10px; }
    td { padding: 4px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    tr:nth-child(even) td { background: #f9fafb; }
    .num { text-align: right; white-space: nowrap; }
    .total td { font-weight: bold; border-top: 2px solid #0f5132; background: #ecfdf5; }
    .empty { color: #6b7280; font-style: italic; padding: 12px 0; }
    .low { color: #b91c1c; font-weight: bold; }
</style>`;

const page = (input: {
    title: string;
    subtitle: string;
    generatedBy: string;
    generatedAt: Date;
    body: string;
}): string => `<!doctype html>
<html lang="es"><head><meta charset="utf-8">${STYLES}</head><body>
<h1>${escapeHtml(input.title)}</h1>
<p class="sub">${escapeHtml(input.subtitle)}</p>
<p class="meta">Generado por ${escapeHtml(input.generatedBy)} el
${escapeHtml(dateFormatter.format(input.generatedAt))} a las
${escapeHtml(timeFormatter.format(input.generatedAt))}</p>
${input.body}
</body></html>`;

export const salesReportHtml = (input: {
    scope: ReportScope;
    kind: 'daily' | 'monthly';
    range: ReportRange;
    rows: SalesPdfRow[];
    generatedBy: string;
    generatedAt: Date;
}): string => {
    const { rows } = input;
    const totalCents = rows.reduce((total, row) => total + toCents(row.amount), 0);

    let body: string;
    if (rows.length === 0) {
        body = `<p class="empty">Sin ventas registradas en ${input.kind === 'daily' ? 'el día' : 'el mes'}.</p>`;
    } else {
        const byDay = new Map<string, { count: number; cents: number }>();
        for (const row of rows) {
            const day = byDay.get(row.date) ?? { count: 0, cents: 0 };
            day.count += 1;
            day.cents += toCents(row.amount);
            byDay.set(row.date, day);
        }
        const daySummary = input.kind === 'monthly'
            ? `<h2>Resumen por día</h2>
<table><thead><tr><th>Día</th><th class="num">Ventas</th><th class="num">Total</th></tr></thead><tbody>
${[...byDay.entries()].map(([date, day]) => `<tr><td>${escapeHtml(date)}</td>
<td class="num">${day.count}</td><td class="num">${escapeHtml(formatCurrency(fromCents(day.cents)))}</td></tr>`).join('')}
</tbody></table>`
            : '';
        const detailRows = rows.map((row) => `<tr>
<td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.time)}</td><td>${escapeHtml(row.folio)}</td>
<td>${escapeHtml(row.cashier)}</td><td>${escapeHtml(row.payment)}</td><td>${escapeHtml(row.concept)}</td>
<td class="num">${escapeHtml(formatCurrency(row.amount))}</td></tr>`).join('');
        body = `${daySummary}
<h2>Detalle de ventas</h2>
<table><thead><tr><th>Fecha</th><th>Hora</th><th>Folio</th><th>Cobró</th><th>Pago</th><th>Concepto</th><th class="num">Importe</th></tr></thead>
<tbody>${detailRows}
<tr class="total"><td colspan="6">Total · ${rows.length} ventas</td>
<td class="num">${escapeHtml(formatCurrency(fromCents(totalCents)))}</td></tr>
</tbody></table>`;
    }

    return page({
        title: `${input.kind === 'daily' ? 'Ventas del día' : 'Ventas del mes'} · ${SCOPE_TITLES[input.scope]}`,
        subtitle: input.range.label,
        generatedBy: input.generatedBy,
        generatedAt: input.generatedAt,
        body,
    });
};

/** Nombres de quien cobró (o registró) por uid; los que no se resuelven quedan fuera. */
const resolveUserNames = async (ids: readonly string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(ids.filter(Boolean))];
    const profiles = await Promise.all(unique.map((uid) => usersRepo.getUserProfile(uid)));
    const names = new Map<string, string>();
    unique.forEach((uid, index) => {
        const profile = profiles[index];
        const name = profile?.displayName || profile?.email;
        if (name) {
            names.set(uid, name);
        }
    });
    return names;
};

export const buildSalesPdf = async (input: {
    scope: ReportScope;
    kind: 'daily' | 'monthly';
    /** `YYYY-MM-DD` o `YYYY-MM`; por defecto hoy / este mes. */
    period?: string;
    generatedBy: string;
    now?: Date;
}): Promise<{ pdf: Buffer; fileName: string }> => {
    const now = input.now ?? new Date();
    const range = input.kind === 'daily'
        ? dayRange(input.period ?? todayYmd(now))
        : monthRange(input.period ?? currentMonth(now));
    const { items: sales } = await salesRepo.listSales({ from: range.from, to: range.to });
    const cashierNames = await resolveUserNames(sales.map((sale) => sale.cashierId));
    const rows = buildSalesRows(sales, input.scope, cashierNames);
    const html = salesReportHtml({
        scope: input.scope,
        kind: input.kind,
        range,
        rows,
        generatedBy: input.generatedBy,
        generatedAt: now,
    });
    return {
        pdf: await renderHtmlToPdf(html),
        fileName: `ventas-${input.kind === 'daily' ? 'dia' : 'mes'}-${input.scope}-${range.slug}.pdf`,
    };
};

/* -------------------------------------------------------------------------- */
/*  Inventario (farmacia)                                                     */
/* -------------------------------------------------------------------------- */

export interface InventoryPdfRow {
    name: string;
    sku: string;
    stock: number;
    minStock: number;
    costValue: number;
    /** Algún lote con existencia no tiene costo capturado: el valor a costo queda corto. */
    missingCost: boolean;
    retailValue: number;
}

export const buildInventoryRows = (
    products: ReadonlyArray<{ id: string; name: string; sku: string; salePrice: number; minStock: number }>,
    batches: ReadonlyArray<{ productId: string; quantity: number; costPrice?: number }>,
): InventoryPdfRow[] => {
    const stock = new Map<string, { units: number; costCents: number; missingCost: boolean }>();
    for (const batch of batches) {
        const entry = stock.get(batch.productId) ?? { units: 0, costCents: 0, missingCost: false };
        entry.units += batch.quantity;
        if (batch.costPrice === undefined || batch.costPrice === null) {
            entry.missingCost = true;
        } else {
            entry.costCents += toCents(batch.costPrice) * batch.quantity;
        }
        stock.set(batch.productId, entry);
    }
    return products
        .map((product) => {
            const entry = stock.get(product.id) ?? { units: 0, costCents: 0, missingCost: false };
            return {
                name: product.name,
                sku: product.sku,
                stock: entry.units,
                minStock: product.minStock,
                costValue: fromCents(entry.costCents),
                missingCost: entry.missingCost,
                retailValue: fromCents(toCents(product.salePrice) * entry.units),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
};

export const inventoryReportHtml = (input: {
    rows: InventoryPdfRow[];
    generatedBy: string;
    generatedAt: Date;
}): string => {
    const { rows } = input;
    const units = rows.reduce((total, row) => total + row.stock, 0);
    const costCents = rows.reduce((total, row) => total + toCents(row.costValue), 0);
    const retailCents = rows.reduce((total, row) => total + toCents(row.retailValue), 0);
    const low = rows.filter((row) => row.stock <= row.minStock).length;
    const body = rows.length === 0
        ? '<p class="empty">No hay productos activos.</p>'
        : `<table><thead><tr><th>Producto</th><th>SKU</th><th class="num">Existencia</th><th class="num">Mínimo</th>
<th class="num">Valor a costo</th><th class="num">Valor a precio de venta</th></tr></thead><tbody>
${rows.map((row) => `<tr>
<td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.sku)}</td>
<td class="num${row.stock <= row.minStock ? ' low' : ''}">${row.stock}</td><td class="num">${row.minStock}</td>
<td class="num">${escapeHtml(formatCurrency(row.costValue))}${row.missingCost ? ' *' : ''}</td>
<td class="num">${escapeHtml(formatCurrency(row.retailValue))}</td></tr>`).join('')}
<tr class="total"><td colspan="2">Total · ${rows.length} productos</td><td class="num">${units}</td><td></td>
<td class="num">${escapeHtml(formatCurrency(fromCents(costCents)))}</td>
<td class="num">${escapeHtml(formatCurrency(fromCents(retailCents)))}</td></tr>
</tbody></table>
<p class="meta">${low} productos en o bajo su mínimo (en rojo). * Algún lote sin costo capturado: el valor a costo queda corto.</p>`;
    return page({
        title: 'Inventario · Farmacia',
        subtitle: `Existencias al ${dateFormatter.format(input.generatedAt)}`,
        generatedBy: input.generatedBy,
        generatedAt: input.generatedAt,
        body,
    });
};

export const buildInventoryPdf = async (input: {
    generatedBy: string;
    now?: Date;
}): Promise<{ pdf: Buffer; fileName: string }> => {
    const now = input.now ?? new Date();
    const [products, batches] = await Promise.all([
        productsRepo.listProducts({ activeOnly: true }),
        batchesRepo.listBatchesWithStock(),
    ]);
    const html = inventoryReportHtml({
        rows: buildInventoryRows(products, batches),
        generatedBy: input.generatedBy,
        generatedAt: now,
    });
    return { pdf: await renderHtmlToPdf(html), fileName: `inventario-farmacia-${todayYmd(now)}.pdf` };
};

/* -------------------------------------------------------------------------- */
/*  Facturas (financiero)                                                     */
/* -------------------------------------------------------------------------- */

export interface InvoicePdfRow {
    supplier: string;
    date: string;
    number: string;
    registeredBy: string;
    registeredAt: string;
}

export const invoicesReportHtml = (input: {
    range: ReportRange;
    rows: InvoicePdfRow[];
    generatedBy: string;
    generatedAt: Date;
}): string => {
    const body = input.rows.length === 0
        ? '<p class="empty">Sin facturas registradas en el mes.</p>'
        : `<table><thead><tr><th>Proveedor</th><th>Fecha</th><th>No. de factura</th><th>Registró</th><th>Registrada</th></tr></thead><tbody>
${input.rows.map((row) => `<tr><td>${escapeHtml(row.supplier)}</td><td>${escapeHtml(row.date)}</td>
<td>${escapeHtml(row.number)}</td><td>${escapeHtml(row.registeredBy)}</td><td>${escapeHtml(row.registeredAt)}</td></tr>`).join('')}
<tr class="total"><td colspan="5">Total · ${input.rows.length} facturas</td></tr>
</tbody></table>`;
    return page({
        title: 'Facturas · Financiero',
        subtitle: input.range.label,
        generatedBy: input.generatedBy,
        generatedAt: input.generatedAt,
        body,
    });
};

export const buildInvoicesPdf = async (input: {
    /** `YYYY-MM`; por defecto este mes. */
    month?: string;
    generatedBy: string;
    now?: Date;
}): Promise<{ pdf: Buffer; fileName: string }> => {
    const now = input.now ?? new Date();
    const range = monthRange(input.month ?? currentMonth(now));
    const invoices = (await invoicesRepo.listInvoices({ from: range.from, to: range.to }))
        .sort((a, b) => a.invoiceDate.toMillis() - b.invoiceDate.toMillis());
    const [suppliers, userNames] = await Promise.all([
        suppliersRepo.getSuppliersByIds(invoices.map((invoice) => invoice.supplierId)),
        resolveUserNames(invoices.map((invoice) => invoice.createdBy)),
    ]);
    const rows: InvoicePdfRow[] = invoices.map((invoice) => {
        const created = invoice.createdAt.toDate();
        return {
            supplier: suppliers.get(invoice.supplierId)?.name ?? 'Proveedor eliminado',
            date: dateFormatter.format(invoice.invoiceDate.toDate()),
            number: invoice.invoiceNumber,
            registeredBy: userNames.get(invoice.createdBy) ?? NO_CASHIER,
            registeredAt: `${dateFormatter.format(created)} ${timeFormatter.format(created)}`,
        };
    });
    const html = invoicesReportHtml({ range, rows, generatedBy: input.generatedBy, generatedAt: now });
    return { pdf: await renderHtmlToPdf(html), fileName: `facturas-${range.slug}.pdf` };
};
