import {
    Receipt,
    ReceiptLine,
    ReceiptTaxLine,
    Sale,
    SaleReturn,
    saleItemName,
} from '../types';
import { getReceiptStore } from '../config/env';
import { formatCurrency } from '../utils/currency';
import { escapeHtml } from '../utils/html';
import { fromCents, toCents } from '../utils/taxes';
import * as salesRepo from '../repositories/sales.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import { notFound } from '../utils/errors';

/** Ancho del rollo térmico en milímetros. */
export type ReceiptWidth = 58 | 80;

const PAYMENT_LABELS: Record<string, string> = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    mixed: 'Mixto',
};

const formatRate = (rate: number): string => `${(rate * 100).toFixed(rate * 100 % 1 ? 1 : 0)}%`;

/**
 * Agrupa impuestos por tasa: el ticket lleva "IVA 16%: $X", no una línea por
 * partida. Las tasas 0% no se imprimen como importe pero sí se anotan al pie,
 * porque el cliente de farmacia pregunta por qué la medicina no lleva IVA.
 */
const buildTaxLines = (
    breakdowns: Array<{ ivaRate: number; ivaAmount: number; iepsRate: number; iepsAmount: number }>,
): ReceiptTaxLine[] => {
    const byKey = new Map<string, ReceiptTaxLine>();

    const push = (label: string, rate: number, amount: number) => {
        if (toCents(amount) === 0) {
            return;
        }
        const key = `${label}:${rate}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.amount = fromCents(toCents(existing.amount) + toCents(amount));
        } else {
            byKey.set(key, { label, rate, amount });
        }
    };

    for (const breakdown of breakdowns) {
        push('IVA', breakdown.ivaRate, breakdown.ivaAmount);
        push('IEPS', breakdown.iepsRate, breakdown.iepsAmount);
    }

    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label) || a.rate - b.rate);
};

const buildSaleReceipt = (sale: Sale): Receipt => {
    // El ticket imprime mercancía y servicios en el mismo cuerpo: para el
    // cliente es un solo cobro, aunque el corte los separe.
    const lines: ReceiptLine[] = sale.items.map((item) => ({
        productName: saleItemName(item),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount + (item.saleDiscountShare ?? 0),
        amount: item.netAmount ?? item.subtotal - item.discountAmount,
    }));

    const notes: string[] = [];
    if (sale.voidedAt) {
        notes.push('VENTA ANULADA');
    }
    if ((sale.refundedTotal ?? 0) > 0) {
        notes.push(`Devuelto: ${formatCurrency(sale.refundedTotal ?? 0)}`);
    }
    if (sale.prescription) {
        notes.push(
            `Receta: ${sale.prescription.doctorName} / céd. ${sale.prescription.doctorLicense}`,
        );
    }
    if (sale.billing) {
        notes.push(`Facturación solicitada: ${sale.billing.rfc}`);
    }
    if (!sale.taxSummary) {
        notes.push('Ticket sin desglose de impuestos (venta anterior al desglose)');
    }

    return {
        kind: 'sale',
        folio: sale.folio,
        issuedAt: sale.createdAt,
        store: getReceiptStore(),
        lines,
        subtotal: sale.subtotal,
        discountTotal: sale.discountTotal,
        taxBase: sale.taxSummary?.base ?? 0,
        taxes: buildTaxLines(
            sale.items.map((item) => item.taxes).filter(Boolean) as Array<
                NonNullable<Sale['items'][number]['taxes']>
            >,
        ),
        total: sale.total,
        paymentMethod: sale.paymentMethod,
        amountReceived: sale.amountReceived,
        change: sale.change,
        cashAmount: sale.cashAmount ?? null,
        cardAmount: sale.cardAmount ?? null,
        cashierId: sale.cashierId,
        customerName: sale.customerName,
        prescription: sale.prescription,
        billing: sale.billing,
        notes,
        voided: Boolean(sale.voidedAt),
    };
};

const buildReturnReceipt = (saleReturn: SaleReturn): Receipt => ({
    kind: 'return',
    folio: saleReturn.folio,
    issuedAt: saleReturn.createdAt,
    store: getReceiptStore(),
    lines: saleReturn.items.map((item) => ({
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: 0,
        amount: item.refundAmount,
    })),
    subtotal: saleReturn.refundTotal,
    discountTotal: 0,
    taxBase: saleReturn.taxSummary.base,
    taxes: buildTaxLines(saleReturn.items.map((item) => item.taxes)),
    total: saleReturn.refundTotal,
    paymentMethod: saleReturn.refundMethod,
    amountReceived: null,
    change: null,
    cashAmount: null,
    cardAmount: null,
    cashierId: saleReturn.createdBy,
    customerName: null,
    prescription: null,
    billing: null,
    notes: [
        `Devolución de la venta ${saleReturn.saleFolio}`,
        `Motivo: ${saleReturn.reason}`,
    ],
    voided: false,
});

/**
 * HTML para rollo térmico. Sin dependencias ni assets externos: el frontend lo
 * inyecta y llama `window.print()`, o lo manda tal cual al driver de la impresora.
 * `@page { margin: 0 }` y el ancho fijo en milímetros son lo que evita que el
 * navegador reescale el ticket a tamaño carta.
 */
export const renderReceiptHtml = (receipt: Receipt, width: ReceiptWidth): string => {
    const contentWidth = width === 58 ? '48mm' : '72mm';
    const title = receipt.kind === 'sale'
        ? `Ticket ${receipt.folio}`
        : `Devolución ${receipt.folio}`;

    const storeLines = [
        receipt.store.rfc ? `RFC: ${receipt.store.rfc}` : null,
        receipt.store.address,
        receipt.store.phone ? `Tel. ${receipt.store.phone}` : null,
    ].filter(Boolean) as string[];

    const itemRows = receipt.lines
        .map((line) => {
            const discountLabel = escapeHtml(formatCurrency(line.discountAmount));
            const discount = toCents(line.discountAmount) > 0
                ? `<div class="muted">Desc. -${discountLabel}</div>`
                : '';
            return `
                <tr>
                    <td colspan="2" class="name">${escapeHtml(line.productName)}${discount}</td>
                </tr>
                <tr>
                    <td class="muted">${line.quantity} x ${
    escapeHtml(formatCurrency(line.unitPrice))
}</td>
                    <td class="num">${escapeHtml(formatCurrency(line.amount))}</td>
                </tr>`;
        })
        .join('');

    const totalRows = [
        toCents(receipt.discountTotal) > 0
            ? ['Descuentos', `-${formatCurrency(receipt.discountTotal)}`]
            : null,
        receipt.taxBase > 0 ? ['Subtotal sin impuestos', formatCurrency(receipt.taxBase)] : null,
        ...receipt.taxes.map((tax): [string, string] => [
            `${tax.label} ${formatRate(tax.rate)}`,
            formatCurrency(tax.amount),
        ]),
    ].filter(Boolean) as Array<[string, string]>;

    const tenderRows = [
        ['Pago', PAYMENT_LABELS[receipt.paymentMethod] ?? receipt.paymentMethod],
        // En pago mixto el ticket debe mostrar el reparto, o el cliente no puede
        // verificar el cambio contra lo que entregó en efectivo.
        receipt.cardAmount !== null && receipt.cashAmount !== null
            ? ['  Tarjeta', formatCurrency(receipt.cardAmount)]
            : null,
        receipt.cardAmount !== null && receipt.cashAmount !== null
            ? ['  Efectivo', formatCurrency(receipt.cashAmount)]
            : null,
        receipt.amountReceived !== null
            ? ['Recibido', formatCurrency(receipt.amountReceived)]
            : null,
        receipt.change !== null ? ['Cambio', formatCurrency(receipt.change)] : null,
    ].filter(Boolean) as Array<[string, string]>;

    const buildRows = (rows: Array<[string, string]>): string => rows
        .map(([label, value]) =>
            `<tr><td>${escapeHtml(label)}</td>` +
            `<td class="num">${escapeHtml(value)}</td></tr>`)
        .join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
    @page { size: ${width}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        padding: 2mm;
        width: ${contentWidth};
        font-family: "Courier New", monospace;
        font-size: 10px;
        line-height: 1.35;
        color: #000;
    }
    h1 { font-size: 12px; margin: 0 0 1mm; text-align: center; text-transform: uppercase; }
    .center { text-align: center; }
    .muted { font-size: 9px; }
    table { width: 100%; border-collapse: collapse; }
    td { vertical-align: top; padding: 0; }
    td.num { text-align: right; white-space: nowrap; }
    td.name { padding-top: 1mm; }
    hr { border: none; border-top: 1px dashed #000; margin: 1.5mm 0; }
    .total { font-size: 12px; font-weight: bold; }
    .badge { text-align: center; font-weight: bold; border: 1px solid #000; padding: 1mm; }
</style>
</head>
<body>
    <h1>${escapeHtml(receipt.store.name)}</h1>
    ${storeLines.map((line) => `<div class="center muted">${escapeHtml(line)}</div>`).join('')}
    <hr>
    <div>${receipt.kind === 'sale' ? 'Ticket' : 'Devolución'}: ${escapeHtml(receipt.folio)}</div>
    <div class="muted">${escapeHtml(receipt.issuedAt.toDate().toLocaleString('es-MX'))}</div>
    <div class="muted">Cajero: ${escapeHtml(receipt.cashierId)}</div>
    ${receipt.customerName
        ? `<div class="muted">Cliente: ${escapeHtml(receipt.customerName)}</div>`
        : ''}
    <hr>
    <table>${itemRows}</table>
    <hr>
    <table>
        ${buildRows(totalRows)}
        <tr class="total">
            <td>${receipt.kind === 'sale' ? 'TOTAL' : 'DEVUELTO'}</td>
            <td class="num">${escapeHtml(formatCurrency(receipt.total))}</td>
        </tr>
        ${buildRows(tenderRows)}
    </table>
    ${receipt.voided ? '<hr><div class="badge">VENTA ANULADA</div>' : ''}
    ${receipt.notes.length ? '<hr>' : ''}
    ${receipt.notes.map((note) => `<div class="muted">${escapeHtml(note)}</div>`).join('')}
    ${receipt.store.footer
        ? `<hr><div class="center muted">${escapeHtml(receipt.store.footer)}</div>`
        : ''}
</body>
</html>`;
};

export const getSaleReceipt = async (
    saleId: string,
    width: ReceiptWidth = 58,
): Promise<{ receipt: Receipt; html: string }> => {
    const sale = await salesRepo.getSaleById(saleId);
    if (!sale) {
        throw notFound('Venta');
    }
    const receipt = buildSaleReceipt(sale);
    return { receipt, html: renderReceiptHtml(receipt, width) };
};

export const getSaleReturnReceipt = async (
    returnId: string,
    width: ReceiptWidth = 58,
): Promise<{ receipt: Receipt; html: string }> => {
    const saleReturn = await returnsRepo.getSaleReturnById(returnId);
    if (!saleReturn) {
        throw notFound('Devolución');
    }
    const receipt = buildReturnReceipt(saleReturn);
    return { receipt, html: renderReceiptHtml(receipt, width) };
};
