import { ColumnType, ReportColumn, ReportData } from './report-definition';

/**
 * Libro de Excel de un reporte: título, periodo, encabezado congelado con filtro,
 * números reales con formato de celda y una fila de totales con fórmula `SUM`.
 *
 * `exceljs` pesa ~20 MB: se importa dentro de la función para que no entre al
 * arranque en frío del `api` (ver "Cost and cold start" en CLAUDE.md). Las
 * cadenas se escriben como celdas de texto, que Excel nunca evalúa, así que no
 * necesitan la guarda de fórmulas del CSV.
 */
const NUMBER_FORMATS: Record<ColumnType, string | undefined> = {
    text: undefined,
    money: '"$"#,##0.00;[Red]-"$"#,##0.00',
    int: '#,##0',
    decimal: '#,##0.00',
    percent: '0.0%',
};

const HEADER_ROW = 4;
const MIN_WIDTH = 10;
const MAX_WIDTH = 60;

/** Excel limita el nombre de hoja a 31 caracteres y prohíbe `\ / ? * [ ] :`. */
export const sheetName = (title: string): string =>
    title.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Reporte';

const toExcelValue = (value: unknown, type: ColumnType): string | number | null => {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        // Los porcentajes viajan en puntos (23.5) y Excel los quiere en fracción (0.235).
        return type === 'percent' ? value / 100 : value;
    }
    return String(value);
};

export const renderXlsx = async (input: {
    title: string;
    columns: readonly ReportColumn[];
    data: ReportData;
    generatedBy: string;
    generatedAt: Date;
}): Promise<Buffer> => {
    const { Workbook } = await import('exceljs');
    const workbook = new Workbook();
    workbook.creator = input.generatedBy;
    workbook.created = input.generatedAt;
    const sheet = workbook.addWorksheet(sheetName(input.title));
    const { columns, data } = input;
    const lastColumn = Math.max(columns.length, 1);

    sheet.mergeCells(1, 1, 1, lastColumn);
    sheet.getCell(1, 1).value = input.title;
    sheet.getCell(1, 1).font = { bold: true, size: 14 };
    sheet.mergeCells(2, 1, 2, lastColumn);
    sheet.getCell(2, 1).value = data.subtitle;
    sheet.getCell(2, 1).font = { color: { argb: 'FF4B5563' } };

    const header = sheet.getRow(HEADER_ROW);
    columns.forEach((column, index) => {
        const cell = header.getCell(index + 1);
        cell.value = column.header;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5132' } };
        cell.alignment = {
            horizontal: column.type === 'text' ? 'left' : 'right',
            vertical: 'middle',
        };
    });

    const widths = columns.map((column) => column.header.length);
    data.rows.forEach((row, rowIndex) => {
        const excelRow = sheet.getRow(HEADER_ROW + 1 + rowIndex);
        columns.forEach((column, index) => {
            const cell = excelRow.getCell(index + 1);
            cell.value = toExcelValue(row[column.key], column.type);
            const format = NUMBER_FORMATS[column.type];
            if (format) {
                cell.numFmt = format;
            }
            widths[index] = Math.max(widths[index], String(row[column.key] ?? '').length);
        });
    });

    const firstData = HEADER_ROW + 1;
    const lastData = HEADER_ROW + data.rows.length;
    if (data.rows.length > 0 && columns.some((column) => column.total)) {
        const totals = sheet.getRow(lastData + 1);
        columns.forEach((column, index) => {
            const cell = totals.getCell(index + 1);
            if (column.total) {
                const letter = sheet.getColumn(index + 1).letter;
                cell.value = { formula: `SUM(${letter}${firstData}:${letter}${lastData})` };
                const format = NUMBER_FORMATS[column.type];
                if (format) {
                    cell.numFmt = format;
                }
            } else if (index === 0) {
                cell.value = `Total · ${data.rows.length} filas`;
            }
            cell.font = { bold: true };
            cell.border = { top: { style: 'medium' } };
        });
    }

    columns.forEach((_column, index) => {
        const width = Math.max(widths[index] + 2, MIN_WIDTH);
        sheet.getColumn(index + 1).width = Math.min(width, MAX_WIDTH);
    });
    sheet.views = [{ state: 'frozen', ySplit: HEADER_ROW }];
    if (data.rows.length > 0) {
        sheet.autoFilter = {
            from: { row: HEADER_ROW, column: 1 },
            to: { row: lastData, column: lastColumn },
        };
    }

    (data.notes ?? []).forEach((note, index) => {
        const noteRow = Math.max(lastData, HEADER_ROW) + 3 + index;
        sheet.mergeCells(noteRow, 1, noteRow, lastColumn);
        sheet.getCell(noteRow, 1).value = note;
        sheet.getCell(noteRow, 1).font = { italic: true, color: { argb: 'FF6B7280' } };
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
};
