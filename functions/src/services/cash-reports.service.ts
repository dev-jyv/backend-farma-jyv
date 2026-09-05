import { CashSession, CashSessionSummary } from '../types';
import { formatCurrency } from '../utils/currency';
import { escapeHtml } from '../utils/html';
import { getReceiptStore } from '../config/env';
import { ReceiptWidth } from './receipts.service';

/**
 * Corte de caja imprimible.
 *
 *  - **Lectura X**: parcial, no cierra el turno; se puede sacar varias veces.
 *  - **Corte Z**: el cierre, con conteo físico y diferencia.
 *
 * Mismo formato de rollo térmico que el ticket (ver `receipts.service`).
 */
export type CashReportKind = 'X' | 'Z';

const METHOD_LABELS: Record<string, string> = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    mixed: 'Mixto',
};

export const renderCashReportHtml = (input: {
    kind: CashReportKind;
    folio: string | null;
    session: CashSession;
    summary: CashSessionSummary;
    /** Esperado de farmacia. */
    expectedCashAmount: number;
    /** Esperado de servicios; solo se imprime si el turno cobró alguno. */
    expectedServicesCashAmount?: number;
    countedCashAmount?: number | null;
    cashDifference?: number | null;
    issuedBy: string;
    issuedAt: Date;
    width: ReceiptWidth;
}): string => {
    const contentWidth = input.width === 58 ? '48mm' : '72mm';
    const title = input.kind === 'X' ? 'Lectura X (parcial)' : 'Corte Z (cierre)';

    const rows: Array<[string, string]> = [
        ['Fondo inicial', formatCurrency(input.session.openingAmount)],
        ['Ventas', `${input.summary.salesCount}`],
        ...Object.entries(input.summary.byMethod).map(([method, totals]): [string, string] => [
            `${METHOD_LABELS[method] ?? method} (${totals.count})`,
            formatCurrency(totals.total),
        ]),
        ['Depósitos', formatCurrency(input.summary.movements.deposits.total)],
        ['Retiros', formatCurrency(input.summary.movements.withdrawals.total)],
        ['Gastos', formatCurrency(input.summary.movements.expenses.total)],
    ];

    if (input.summary.returns && input.summary.returns.count > 0) {
        rows.push([
            `Devoluciones (${input.summary.returns.count})`,
            `-${formatCurrency(input.summary.returns.total)}`,
        ]);
        rows.push([
            'Devuelto en efectivo',
            `-${formatCurrency(input.summary.returns.cashTotal)}`,
        ]);
    }
    if (input.summary.voidedCount > 0) {
        rows.push(['Ventas anuladas', `${input.summary.voidedCount}`]);
    }

    /**
     * Bloque de servicios: aparece **solo si hubo actividad de servicios** en el
     * turno. Un corte de farmacia pura sale exactamente como salía antes.
     */
    const services = input.summary.services;
    const hasServiceActivity = Boolean(
        services && (services.count > 0 || services.voidedCount > 0),
    );
    const servicesRows: Array<[string, string]> = [];
    if (services && hasServiceActivity) {
        servicesRows.push(['Servicios cobrados', `${services.count}`]);
        servicesRows.push(['Total servicios', formatCurrency(services.total)]);
        servicesRows.push(['Comisiones', formatCurrency(services.commissionTotal)]);
        servicesRows.push([
            'Efectivo esperado servicios',
            formatCurrency(input.expectedServicesCashAmount ?? services.cashInDrawer),
        ]);
        if (services.voidedCount > 0) {
            servicesRows.push(['Servicios anulados', `${services.voidedCount}`]);
        }
    }

    const closingRows: Array<[string, string]> = [
        [
            // El cajón es uno solo: cuando hay servicios se aclara de qué rama es
            // cada esperado y se imprime el total, que es contra lo que se cuenta.
            hasServiceActivity ? 'Efectivo esperado (farmacia)' : 'Efectivo esperado',
            formatCurrency(input.expectedCashAmount),
        ],
    ];
    if (hasServiceActivity) {
        closingRows.push([
            'Efectivo esperado (total)',
            formatCurrency(input.expectedCashAmount + (input.expectedServicesCashAmount ?? 0)),
        ]);
    }
    if (input.kind === 'Z') {
        closingRows.push(['Efectivo contado', formatCurrency(input.countedCashAmount ?? 0)]);
        closingRows.push(['Diferencia', formatCurrency(input.cashDifference ?? 0)]);
    }

    const buildRows = (entries: Array<[string, string]>): string => entries
        .map(([label, value]) =>
            `<tr><td>${escapeHtml(label)}</td>` +
            `<td class="num">${escapeHtml(value)}</td></tr>`)
        .join('');

    const store = getReceiptStore();

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(`${title} ${input.folio ?? ''}`.trim())}</title>
<style>
    @page { size: ${input.width}mm auto; margin: 0; }
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
    td { padding: 0; vertical-align: top; }
    td.num { text-align: right; white-space: nowrap; }
    hr { border: none; border-top: 1px dashed #000; margin: 1.5mm 0; }
    .total { font-size: 12px; font-weight: bold; }
    .badge { text-align: center; font-weight: bold; border: 1px solid #000; padding: 1mm; }
</style>
</head>
<body>
    <h1>${escapeHtml(store.name)}</h1>
    <div class="center">${escapeHtml(title)}</div>
    ${input.folio ? `<div class="center muted">${escapeHtml(input.folio)}</div>` : ''}
    <hr>
    <div class="muted">Turno: ${escapeHtml(input.session.id)}</div>
    <div class="muted">Abierto por: ${escapeHtml(input.session.openedBy)}</div>
    <div class="muted">Emitido por: ${escapeHtml(input.issuedBy)}</div>
    <div class="muted">${escapeHtml(input.issuedAt.toLocaleString('es-MX'))}</div>
    <hr>
    <table>${buildRows(rows)}</table>
    ${servicesRows.length
        ? `<hr><div class="center">SERVICIOS</div><table>${buildRows(servicesRows)}</table>`
        : ''}
    <hr>
    <table>
        <tr class="total">
            <td>Total vendido</td>
            <td class="num">${escapeHtml(formatCurrency(input.summary.grandTotal))}</td>
        </tr>
        ${buildRows(closingRows)}
    </table>
    ${input.kind === 'X'
        ? '<hr><div class="badge">LECTURA PARCIAL — EL TURNO SIGUE ABIERTO</div>'
        : ''}
</body>
</html>`;
};
