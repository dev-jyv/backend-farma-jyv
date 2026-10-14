import { notFound } from '../../utils/errors';
import { ExportFormat, ExportQuery } from './report-definition';
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

/** Carga el reporte una vez y lo entrega en el formato pedido. */
export const exportReport = async (input: {
    report: string;
    format: ExportFormat;
    query: ExportQuery;
    generatedBy: string;
    roleSlug: string;
    now?: Date;
}): Promise<ExportedReport> => {
    const definition = REPORT_REGISTRY.get(input.report);
    if (!definition) {
        throw notFound('Reporte');
    }
    const now = input.now ?? new Date();
    const context = { query: input.query, now, roleSlug: input.roleSlug };
    definition.authorize?.(context);
    const data = await definition.load(context);

    const render = {
        title: definition.title,
        columns: definition.columns,
        data,
        generatedBy: input.generatedBy,
        generatedAt: now,
    };
    const body = input.format === 'pdf'
        ? await renderPdf(render)
        : input.format === 'xlsx'
            ? await renderXlsx(render)
            : renderCsv(definition.columns, data.rows);
    return {
        body,
        contentType: CONTENT_TYPES[input.format],
        fileName: `${definition.key}-${data.slug}.${input.format}`,
    };
};
