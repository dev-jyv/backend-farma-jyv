import { EXPENSE_CATEGORY_LABELS } from '../constants/expenses';
import { CashMovement } from '../types';
import { formatCurrency } from '../utils/currency';
import { FixedAssetView } from './accounting-core.service';
import { BalanceSheet, IncomeStatement, PayablesReport } from './accounting.service';
import { renderHtmlToPdf } from './report-pdf.service';

/**
 * Exportación de contabilidad: PDF para leer y firmar, CSV para que el contador
 * lo abra en su hoja de cálculo.
 *
 * **Los CSV llevan números crudos**, sin símbolo de moneda ni separador de
 * miles: en cuanto se escribe "$ 1,234.56" Excel lo trata como texto y la
 * columna deja de sumarse, que es lo primero que hace quien recibe el archivo.
 * El formato bonito es cosa del PDF.
 */

/** Excel no reconoce UTF-8 sin BOM y parte los acentos del catálogo de gastos. */
const BOM = '﻿';

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/** Comilla solo cuando hace falta, y duplica las comillas internas. */
const csvCell = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'number') {
        // Punto decimal y dos posiciones: es lo que Excel en México lee como
        // número. `toLocaleString` metería comas y lo volvería texto.
        return value.toFixed(2);
    }
    return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

const csvRows = (rows: Array<Array<string | number | null | undefined>>): string =>
    BOM + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** `YYYY-MM-DD`, que es lo que una hoja de cálculo reconoce como fecha. */
const isoDay = (value: Date | string | null | undefined): string => {
    if (!value) {
        return '';
    }
    const date = typeof value === 'string' ? new Date(value) : value;
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const periodLabel = (from: string, to: string): string =>
    `Del ${isoDay(from)} al ${isoDay(to)}`;

/* -------------------------------------------------------------------------- */
/*  CSV                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Estado de resultados en columnas. Se exporta con la **sección** en su propia
 * columna para que el contador pueda filtrar o pivotar sin volver a teclear la
 * estructura del informe.
 */
export const incomeStatementCsv = (statement: IncomeStatement): string => {
    const rows: Array<Array<string | number | null>> = [
        ['Periodo', periodLabel(statement.period.from, statement.period.to)],
        [],
        ['Sección', 'Concepto', 'Importe'],
        ['Ingresos', 'Venta de mercancía (sin impuestos)', statement.revenue.pharmacy],
        ['Ingresos', 'Servicios cobrados (sin impuestos)', statement.revenue.services],
        ['Ingresos', 'Devoluciones', -statement.revenue.returns],
        ['Ingresos', 'Ingreso neto', statement.revenue.net],
        ['Costo de ventas', 'Costo de la mercancía vendida', -statement.costOfSales.merchandise],
        ['Costo de ventas', 'Mermas y caducidades', -statement.costOfSales.waste],
        ['Resultado', 'Utilidad bruta', statement.grossProfit],
    ];

    for (const line of statement.operatingExpenses.byCategory) {
        rows.push(['Gastos de operación', line.label, -line.total]);
    }
    rows.push(
        ['Gastos de operación', 'Comisiones de doctores', -statement.operatingExpenses.commissions],
        ['Gastos de operación', 'Depreciación', -statement.operatingExpenses.depreciation],
        ['Resultado', 'Utilidad de operación', statement.operatingIncome],
        [],
        ['Impuestos', 'IVA trasladado', statement.taxes.ivaCharged],
        ['Impuestos', 'IVA acreditable', statement.taxes.ivaCreditable],
        ['Impuestos', 'IVA por pagar', statement.taxes.ivaPayable],
        ['Impuestos', 'IEPS trasladado', statement.taxes.iepsCharged],
    );

    // Las advertencias viajan **dentro** del archivo: el contador que lo abre en
    // su despacho no tiene la pantalla enfrente para enterarse de que la
    // utilidad está calculada sobre ventas sin costo.
    if (statement.reliability.warnings.length > 0) {
        rows.push([], ['Notas']);
        for (const warning of statement.reliability.warnings) {
            rows.push(['', warning]);
        }
    }

    return csvRows(rows);
};

/** Auxiliar de gastos: un renglón por movimiento, con su origen y medio de pago. */
export const expensesCsv = (movements: CashMovement[]): string => {
    const rows: Array<Array<string | number | null>> = [
        [
            'Fecha',
            'Categoría',
            'Motivo',
            'Descripción',
            'Medio de pago',
            'Origen',
            'Registrado por',
            'Monto',
        ],
    ];

    for (const movement of movements) {
        rows.push([
            isoDay((movement.occurredAt ?? movement.createdAt).toDate()),
            movement.category ? EXPENSE_CATEGORY_LABELS[movement.category] : 'Sin categoría',
            movement.reason,
            movement.description ?? '',
            movement.paymentMethod ?? 'cash',
            movement.cashSessionId === null ? 'Fuera de caja' : 'Del cajón',
            movement.createdByLabel ?? movement.createdBy,
            movement.amount,
        ]);
    }

    return csvRows(rows);
};

export const payablesCsv = (report: PayablesReport): string => {
    const rows: Array<Array<string | number | null>> = [
        ['Saldo a proveedores al', isoDay(report.asOf)],
        [],
        [
            'Folio',
            'Proveedor',
            'Fecha',
            'Vencimiento',
            'Días vencido',
            'Total',
            'Abonado',
            'Saldo',
        ],
    ];

    for (const invoice of report.invoices) {
        rows.push([
            invoice.invoiceNumber,
            invoice.supplierName,
            isoDay(invoice.invoiceDate),
            isoDay(invoice.dueDate),
            // Como texto y no como número: `csvCell` da dos decimales a todo lo
            // numérico —correcto para dinero, absurdo para "30.00 días".
            invoice.daysOverdue === null ? '' : String(invoice.daysOverdue),
            invoice.totalAmount,
            invoice.paidTotal,
            invoice.balance,
        ]);
    }

    rows.push([], ['Total', '', '', '', '', '', '', report.total]);
    return csvRows(rows);
};

export const fixedAssetsCsv = (assets: FixedAssetView[]): string => {
    const rows: Array<Array<string | number | null>> = [
        [
            'Bien',
            'Categoría',
            'Compra',
            'Costo',
            'Vida útil (meses)',
            'Valor de rescate',
            'Depreciación mensual',
            'Depreciación acumulada',
            'Valor neto',
            'Baja',
        ],
    ];

    for (const asset of assets) {
        rows.push([
            asset.name,
            asset.category,
            isoDay(asset.acquiredAt.toDate()),
            asset.cost,
            // Meses, no dinero: ver el comentario de `daysOverdue`.
            String(asset.usefulLifeMonths),
            asset.salvageValue,
            asset.monthlyDepreciation,
            asset.accumulatedDepreciation,
            asset.netValue,
            asset.disposedAt ? isoDay(asset.disposedAt.toDate()) : '',
        ]);
    }

    return csvRows(rows);
};

/* -------------------------------------------------------------------------- */
/*  PDF                                                                       */
/* -------------------------------------------------------------------------- */

const PDF_STYLES = `
  body {
    font-family: Helvetica, Arial, sans-serif;
    color: #111827;
    font-size: 12px;
    margin: 0;
    padding: 32px 40px;
  }
  .brand {
    color: #166534;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0;
  }
  h1 { font-size: 20px; margin: 6px 0 0; }
  .period { color: #555555; font-size: 12px; margin: 4px 0 16px; }
  h2 { font-size: 14px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 7px 6px; text-align: left; }
  th { font-weight: 700; }
  td.num, th.num { text-align: right; }
  tr.total td { border-top: 2px solid #9ca3af; font-weight: 700; }
  tr.section td { padding-top: 14px; font-weight: 700; border-bottom: none; }
  .indent { padding-left: 18px; }
  .notes { margin-top: 20px; background: #fef3c7; padding: 12px 14px; border-radius: 6px; }
  .notes p { margin: 0 0 6px; font-weight: 700; }
  .notes ul { margin: 0; padding-left: 18px; }
  .notes li { margin-bottom: 4px; }
`;

const money = (value: number): string => escapeHtml(formatCurrency(value));

/** Renglón del informe; `negative` lo pinta entre paréntesis, como en el papel. */
const pdfRow = (
    label: string,
    value: number,
    options: { indent?: boolean; total?: boolean; negative?: boolean } = {},
): string => {
    const amount = options.negative ? `(${money(value)})` : money(value);
    return `<tr class="${options.total ? 'total' : ''}">` +
        `<td class="${options.indent ? 'indent' : ''}">${escapeHtml(label)}</td>` +
        `<td class="num">${amount}</td></tr>`;
};

const sectionRow = (label: string): string =>
    `<tr class="section"><td colspan="2">${escapeHtml(label)}</td></tr>`;

const notesBlock = (title: string, notes: string[]): string => {
    if (notes.length === 0) {
        return '';
    }
    return `<div class="notes"><p>${escapeHtml(title)}</p><ul>` +
        notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('') +
        '</ul></div>';
};

/** Opciones repetidas de los renglones que restan; evita rebasar el ancho. */
const negativeLine = { indent: true, negative: true };
const negativeTotal = { total: true, negative: true };

export const incomeStatementPdf = (statement: IncomeStatement): Promise<Buffer> => {
    const expenseRows = statement.operatingExpenses.byCategory
        .map((line) => pdfRow(line.label, line.total, { indent: true, negative: true }))
        .join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><style>${PDF_STYLES}</style></head>
<body>
  <p class="brand">FarmaJyV</p>
  <h1>Estado de resultados</h1>
  <p class="period">${escapeHtml(periodLabel(statement.period.from, statement.period.to))}</p>
  <table>
    <thead><tr><th>Concepto</th><th class="num">Importe</th></tr></thead>
    <tbody>
      ${sectionRow('Ingresos')}
      ${pdfRow('Venta de mercancía (sin impuestos)', statement.revenue.pharmacy, { indent: true })}
      ${pdfRow('Servicios cobrados (sin impuestos)', statement.revenue.services, { indent: true })}
      ${pdfRow('Devoluciones', statement.revenue.returns, { indent: true, negative: true })}
      ${pdfRow('Ingreso neto', statement.revenue.net, { total: true })}
      ${sectionRow('Costo de ventas')}
      ${pdfRow('Costo de la mercancía vendida', statement.costOfSales.merchandise, negativeLine)}
      ${pdfRow('Mermas y caducidades', statement.costOfSales.waste, negativeLine)}
      ${pdfRow('Utilidad bruta', statement.grossProfit, { total: true })}
      ${sectionRow('Gastos de operación')}
      ${expenseRows}
      ${pdfRow('Comisiones de doctores', statement.operatingExpenses.commissions, negativeLine)}
      ${pdfRow('Depreciación', statement.operatingExpenses.depreciation, negativeLine)}
      ${pdfRow('Total de gastos de operación', statement.operatingExpenses.total, negativeTotal)}
      ${pdfRow('Utilidad de operación', statement.operatingIncome, { total: true })}
    </tbody>
  </table>

  <h2>Impuestos del periodo</h2>
  <table>
    <tbody>
      ${pdfRow('IVA trasladado', statement.taxes.ivaCharged)}
      ${pdfRow('IVA acreditable', statement.taxes.ivaCreditable)}
      ${pdfRow('IVA por pagar', statement.taxes.ivaPayable, { total: true })}
      ${pdfRow('IEPS trasladado', statement.taxes.iepsCharged)}
    </tbody>
  </table>

  ${notesBlock('Qué tan completa está esta cifra', statement.reliability.warnings)}
</body>
</html>`;

    return renderHtmlToPdf(html);
};

const balancePeriodLabel = (balance: BalanceSheet): string => {
    const base = `Al ${isoDay(balance.asOf)}`;
    return balance.startDate
        ? `${base} · arranque contable ${isoDay(balance.startDate)}`
        : base;
};

export const balanceSheetPdf = (balance: BalanceSheet): Promise<Buffer> => {
    const cuadre = balance.check.balanced
        ? 'El balance cuadra.'
        : `El balance no cuadra. Diferencia: ${formatCurrency(balance.check.difference)}.`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><style>${PDF_STYLES}</style></head>
<body>
  <p class="brand">FarmaJyV</p>
  <h1>Balance general</h1>
  <p class="period">${escapeHtml(balancePeriodLabel(balance))}</p>

  <h2>Activo</h2>
  <table><tbody>
    ${pdfRow('Efectivo en caja', balance.assets.cash)}
    ${pdfRow('Bancos', balance.assets.bank)}
    ${pdfRow('Inventario', balance.assets.inventory)}
    ${pdfRow('Activo fijo (costo)', balance.assets.fixedAssetsGross)}
    ${pdfRow('Depreciación acumulada', balance.assets.accumulatedDepreciation, { negative: true })}
    ${pdfRow('Total activo', balance.assets.total, { total: true })}
  </tbody></table>

  <h2>Pasivo</h2>
  <table><tbody>
    ${pdfRow('Proveedores', balance.liabilities.payables)}
    ${pdfRow('IVA por pagar', balance.liabilities.taxesPayable)}
    ${pdfRow('Total pasivo', balance.liabilities.total, { total: true })}
  </tbody></table>

  <h2>Capital contable</h2>
  <table><tbody>
    ${pdfRow('Aportaciones', balance.equity.contributions)}
    ${pdfRow('Retiros', balance.equity.withdrawals, { negative: true })}
    ${pdfRow('Resultados acumulados', balance.equity.openingRetainedEarnings)}
    ${pdfRow('Resultado del periodo', balance.equity.periodResult)}
    ${pdfRow('Total capital', balance.equity.total, { total: true })}
  </tbody></table>

  ${notesBlock(cuadre, balance.notes)}
</body>
</html>`;

    return renderHtmlToPdf(html);
};
