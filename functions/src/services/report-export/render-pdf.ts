import { formatCurrency } from '../../utils/currency';
import { escapeHtml, page } from '../module-reports.service';
import { renderHtmlToPdf } from '../report-pdf.service';
import {
    Cell,
    ColumnType,
    ReportColumn,
    ReportData,
    ReportRow,
    sumColumn,
} from './report-definition';

const numberFormat = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

export const displayCell = (value: Cell, type: ColumnType): string => {
    if (value === null || value === undefined) {
        return '—';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (type === 'money') {
        return formatCurrency(value);
    }
    if (type === 'int') {
        return numberFormat.format(value);
    }
    return type === 'percent' ? `${decimalFormat.format(value)}%` : decimalFormat.format(value);
};

const isNumeric = (column: ReportColumn): boolean => column.type !== 'text';

const totalsRow = (columns: readonly ReportColumn[], rows: readonly ReportRow[]): string => {
    const cells = columns.map((column, index) => {
        if (column.total) {
            const total = displayCell(sumColumn(rows, column.key), column.type);
            return `<td class="num">${escapeHtml(total)}</td>`;
        }
        return index === 0 ? `<td>Total · ${rows.length} filas</td>` : '<td></td>';
    });
    return `<tr class="total">${cells.join('')}</tr>`;
};

const headerCell = (column: ReportColumn): string =>
    `<th${isNumeric(column) ? ' class="num"' : ''}>${escapeHtml(column.header)}</th>`;

const bodyCell = (column: ReportColumn, row: ReportRow): string => {
    const text = displayCell(row[column.key] ?? null, column.type);
    return `<td${isNumeric(column) ? ' class="num"' : ''}>${escapeHtml(text)}</td>`;
};

/** HTML del reporte; puro, para poder probarlo sin abrir Chromium. */
export const reportHtml = (input: {
    title: string;
    columns: readonly ReportColumn[];
    data: ReportData;
    generatedBy: string;
    generatedAt: Date;
}): string => {
    const { columns, data } = input;
    const empty = escapeHtml(data.emptyMessage ?? 'Sin registros en el periodo.');
    const rows = data.rows
        .map((row) => `<tr>${columns.map((column) => bodyCell(column, row)).join('')}</tr>`)
        .join('');
    const totals = columns.some((column) => column.total) ? totalsRow(columns, data.rows) : '';
    const body = data.rows.length === 0
        ? `<p class="empty">${empty}</p>`
        : `<table><thead><tr>${columns.map(headerCell).join('')}</tr></thead>
<tbody>${rows}${totals}</tbody></table>`;
    const notes = (data.notes ?? [])
        .map((note) => `<p class="meta">${escapeHtml(note)}</p>`)
        .join('');
    return page({
        title: input.title,
        subtitle: data.subtitle,
        generatedBy: input.generatedBy,
        generatedAt: input.generatedAt,
        body: body + notes,
    });
};

export const renderPdf = async (input: Parameters<typeof reportHtml>[0]): Promise<Buffer> =>
    renderHtmlToPdf(reportHtml(input));
