import { ReportScope } from '../module-reports.service';

/**
 * Contrato de un reporte exportable. Una sola definición alimenta PDF, Excel y
 * CSV: las filas llevan **números crudos** (pesos, unidades, porcentaje en
 * puntos) y solo el renderizador decide cómo mostrarlos. Si la fila trajera el
 * importe ya formateado, Excel recibiría texto y no podría sumar.
 */

export type ColumnType = 'text' | 'money' | 'int' | 'decimal' | 'percent';

export interface ReportColumn {
    key: string;
    header: string;
    type: ColumnType;
    /** La fila de totales suma esta columna. */
    total?: boolean;
}

export type Cell = string | number | null;
export type ReportRow = Record<string, Cell>;

export const EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

/** Parámetros de la URL que un reporte puede usar; los que no use los ignora. */
export interface ExportQuery {
    /** `YYYY-MM-DD`. Con `from`/`to` el periodo es un rango libre. */
    from?: string;
    to?: string;
    /** `YYYY-MM-DD`: un solo día. */
    date?: string;
    /** `YYYY-MM`: un mes completo. */
    month?: string;
    scope?: ReportScope;
    /** Ventana en días de los reportes que miran hacia atrás (sin movimiento). */
    days?: number;
}

export interface ExportContext {
    query: ExportQuery;
    now: Date;
    roleSlug: string;
}

export interface ReportData {
    /** Segunda línea del encabezado: periodo o fecha de corte. */
    subtitle: string;
    /** Parte del nombre del archivo: `2026-10`, `2026-10-01_2026-10-13`... */
    slug: string;
    rows: ReportRow[];
    /** Aclaraciones al pie del PDF; no entran al CSV. */
    notes?: string[];
    emptyMessage?: string;
}

export interface ReportDefinition {
    key: string;
    title: string;
    columns: ReportColumn[];
    /** Verificación adicional a `dashboard:read`; lanza `AppError` si no procede. */
    authorize?: (context: ExportContext) => void;
    load: (context: ExportContext) => Promise<ReportData>;
}

/** Suma por columna en centavos: 0.1 + 0.2 no debe dar 0.30000000000000004. */
export const sumColumn = (rows: readonly ReportRow[], key: string): number => {
    const cents = rows.reduce((total, row) => {
        const value = row[key];
        return total + (typeof value === 'number' ? Math.round(value * 100) : 0);
    }, 0);
    return cents / 100;
};
