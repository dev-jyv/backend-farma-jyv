import { escapeCsvValue } from '../../utils/csv';
import { Cell, ColumnType, ReportColumn, ReportRow } from './report-definition';

/**
 * CSV de un reporte, con BOM y CRLF como el resto de exportaciones.
 *
 * Los números no pasan por `escapeCsvValue`: su guarda de fórmulas antepone un
 * apóstrofo a todo lo que empieza con `-`, y una utilidad de `-35.5` saldría
 * como texto `'-35.5` que Excel ya no suma. Un número no puede ser una fórmula;
 * el texto sí, y ese sigue pasando por la guarda.
 */
const plainNumber = (value: number, type: ColumnType): string =>
    type === 'int' ? String(Math.round(value)) : value.toFixed(2);

const csvCell = (value: Cell, type: ColumnType): string => {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? plainNumber(value, type) : '';
    }
    return escapeCsvValue(value);
};

export const renderCsv = (columns: readonly ReportColumn[], rows: readonly ReportRow[]): Buffer => {
    const lines = [
        columns.map((column) => escapeCsvValue(column.header)).join(','),
        ...rows.map((row) => columns
            .map((column) => csvCell(row[column.key] ?? null, column.type))
            .join(',')),
    ];
    return Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
};
