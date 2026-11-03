import { hasPermission } from '../../constants/permissions';
import { RolePermission } from '../../types';
import { forbidden, notFound } from '../../utils/errors';
import {
    ColumnType,
    ExportFormat,
    ExportQuery,
    ReportData,
    ReportDefinition,
    ReportRow,
    sumColumn,
} from './report-definition';
import { renderCsv } from './render-csv';
import { renderPdf } from './render-pdf';
import { renderXlsx } from './render-xlsx';
import { REPORT_REGISTRY } from './registry';

const CONTENT_TYPES: Record<ExportFormat, string> = {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv; charset=utf-8',
};

export interface ExportedReport {
    body: Buffer;
    contentType: string;
    fileName: string;
}

/**
 * Reportes que abre `reportDownloads:read` sin `dashboard:read` (SPEC 45): ventas
 * de farmacia, ventas de consultorio y compras. Es lo único que ve el contador.
 */
export const REPORT_DOWNLOAD_KEYS: readonly string[] = ['ventas', 'facturas'];

/** `scope` de `ventas` que abre `reportDownloads`: nunca `financial` (el agregado). */
const REPORT_DOWNLOAD_SALES_SCOPES: readonly string[] = ['pharmacy', 'clinic'];

export interface ExportAccess {
    roleSlug: string;
    /**
     * Permisos del usuario. Sin ellos solo el admin (por slug) tiene
     * `dashboard:read`: omitirlos restringe, nunca abre.
     */
    permissions?: RolePermission[];
}

/**
 * Qué reportes puede sacar cada quien. Con `dashboard:read` (o admin), todos,
 * sujetos al `authorize` de cada reporte. Sin él —el contador, o un rol
 * personalizado con `reportDownloads`— solo `ventas` de farmacia o consultorio y
 * `facturas`; `ventas` sin `scope` cae en `financial` y también se rechaza.
 *
 * Vive aquí y no en el controller para que `api` y `reportsPdf`, que comparten
 * `exportReport`, no puedan divergir. El guard de la ruta ya exigió una de las
 * dos áreas; esto decide qué abre cada una.
 */
export const assertCanExportReport = (
    report: string,
    query: ExportQuery,
    access: ExportAccess,
): void => {
    if (hasPermission(access.permissions ?? [], 'dashboard', 'read', access.roleSlug)) {
        return;
    }
    // El guard ya exigió una de las dos áreas; se vuelve a mirar aquí para que
    // un llamador interno sin guard (el correo, un script) no abra nada de más.
    const allowed = hasPermission(access.permissions ?? [], 'reportDownloads', 'read') &&
        REPORT_DOWNLOAD_KEYS.includes(report) &&
        (report !== 'ventas' || REPORT_DOWNLOAD_SALES_SCOPES.includes(query.scope ?? ''));
    if (!allowed) {
        throw forbidden('No tienes permiso para este reporte');
    }
};

/** Busca el reporte, aplica las dos capas de autorización y carga sus filas. */
const loadAuthorized = async (input: {
    report: string;
    query: ExportQuery;
    now?: Date;
} & ExportAccess) => {
    const definition = REPORT_REGISTRY.get(input.report);
    if (!definition) {
        throw notFound('Reporte');
    }
    assertCanExportReport(input.report, input.query, input);
    const now = input.now ?? new Date();
    const context = { query: input.query, now, roleSlug: input.roleSlug };
    definition.authorize?.(context);
    const data = await definition.load(context);
    return { definition, data, now };
};

const renderFile = async (
    definition: ReportDefinition,
    data: ReportData,
    format: ExportFormat,
    generatedBy: string,
    generatedAt: Date,
): Promise<ExportedReport> => {
    const render = {
        title: definition.title,
        columns: definition.columns,
        data,
        generatedBy,
        generatedAt,
    };
    const body = format === 'pdf'
        ? await renderPdf(render)
        : format === 'xlsx'
            ? await renderXlsx(render)
            : renderCsv(definition.columns, data.rows);
    return {
        body,
        contentType: CONTENT_TYPES[format],
        fileName: `${definition.key}-${data.slug}.${format}`,
    };
};

/** Carga el reporte una vez y lo entrega en el formato pedido. */
export const exportReport = async (input: {
    report: string;
    format: ExportFormat;
    query: ExportQuery;
    generatedBy: string;
    now?: Date;
} & ExportAccess): Promise<ExportedReport> => {
    const { definition, data, now } = await loadAuthorized(input);
    return renderFile(definition, data, input.format, input.generatedBy, now);
};

/**
 * Un reporte en varios formatos con **una sola carga**, más sus totales. Para el
 * correo del contador (SPEC 45): pedir PDF y XLSX por separado leería el mes de
 * ventas dos veces, y los totales del cuerpo saldrían de una tercera lectura.
 */
export const exportReportBundle = async (input: {
    report: string;
    formats: readonly ExportFormat[];
    query: ExportQuery;
    generatedBy: string;
    now?: Date;
} & ExportAccess): Promise<{ files: ExportedReport[]; preview: ReportPreview }> => {
    const { definition, data, now } = await loadAuthorized(input);
    const files: ExportedReport[] = [];
    // En serie: dos PDF a la vez compartirían el GiB de la instancia con Chromium.
    for (const format of input.formats) {
        files.push(await renderFile(definition, data, format, input.generatedBy, now));
    }
    return { files, preview: buildReportPreview(definition, data.rows) };
};

/** Tope de filas de la vista previa: es para mirar, la descarga trae todo. */
export const REPORT_PREVIEW_MAX_ROWS = 500;

/** Columnas que suman en la vista previa; el porcentaje no se suma. */
const SUMMABLE_TYPES: readonly ColumnType[] = ['money', 'int', 'decimal'];

export interface ReportPreview {
    columns: Array<{ key: string; label: string; type: ColumnType }>;
    rows: ReportRow[];
    /** Suma de cada columna numérica sobre **todas** las filas, no solo las mostradas. */
    totals: Record<string, number>;
    /** `true` cuando el periodo tiene más de `REPORT_PREVIEW_MAX_ROWS` filas. */
    truncated: boolean;
    /** Filas del periodo completo; `rows.length` se queda en el tope. */
    rowCount: number;
}

export const buildReportPreview = (
    definition: Pick<ReportDefinition, 'columns'>,
    rows: readonly ReportRow[],
): ReportPreview => {
    const totals: Record<string, number> = {};
    for (const column of definition.columns) {
        if (SUMMABLE_TYPES.includes(column.type)) {
            totals[column.key] = sumColumn(rows, column.key);
        }
    }
    return {
        columns: definition.columns.map((column) => ({
            key: column.key,
            label: column.header,
            type: column.type,
        })),
        rows: rows.slice(0, REPORT_PREVIEW_MAX_ROWS),
        totals,
        truncated: rows.length > REPORT_PREVIEW_MAX_ROWS,
        rowCount: rows.length,
    };
};

/**
 * `format=json` (SPEC 45): la misma carga y la misma autorización que la descarga,
 * en filas para pintar una vista previa en el panel sin bajar el archivo.
 */
export const previewReport = async (input: {
    report: string;
    query: ExportQuery;
    now?: Date;
} & ExportAccess): Promise<ReportPreview> => {
    const { definition, data } = await loadAuthorized(input);
    return buildReportPreview(definition, data.rows);
};
