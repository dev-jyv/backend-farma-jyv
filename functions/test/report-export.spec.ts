import ExcelJS from 'exceljs';
import { reportExportQuerySchema } from '../src/schemas';
import { exportReport } from '../src/services/report-export/export-report';
import { resolveReportPeriod } from '../src/services/report-export/period';
import { REPORT_KEYS, REPORT_REGISTRY } from '../src/services/report-export/registry';
import { renderCsv } from '../src/services/report-export/render-csv';
import { reportHtml } from '../src/services/report-export/render-pdf';
import { renderXlsx, sheetName } from '../src/services/report-export/render-xlsx';
import { ReportColumn, ReportData } from '../src/services/report-export/report-definition';
import * as salesRepo from '../src/repositories/sale-returns.repository';
import * as salesListRepo from '../src/repositories/sales.repository';
import { impuestos } from '../src/services/report-export/definitions/financial';

jest.mock('../src/repositories/sales.repository');
jest.mock('../src/repositories/sale-returns.repository');

const columns: ReportColumn[] = [
    { key: 'name', header: 'Producto', type: 'text' },
    { key: 'units', header: 'Unidades', type: 'int', total: true },
    { key: 'profit', header: 'Utilidad', type: 'money', total: true },
    { key: 'margin', header: 'Margen', type: 'percent' },
];

const data: ReportData = {
    subtitle: 'Octubre 2026',
    slug: '2026-10',
    rows: [
        { name: 'Paracetamol', units: 10, profit: 120.5, margin: 23.5 },
        { name: '=HYPERLINK("http://x")', units: 2, profit: -35.5, margin: null },
        { name: 'Jarabe, 120 ml', units: 1, profit: 0.1, margin: 5 },
    ],
    notes: ['Nota <b>al pie</b>'],
};

const at = (iso: string) => ({ toMillis: () => Date.parse(iso), toDate: () => new Date(iso) });

describe('renderCsv', () => {
    const text = renderCsv(columns, data.rows).toString('utf8');
    const lines = text.split('\r\n');

    it('empieza con BOM, usa CRLF y trae el encabezado', () => {
        expect(text.startsWith('﻿')).toBe(true);
        expect(lines[0]).toBe('﻿Producto,Unidades,Utilidad,Margen');
    });

    it('deja los números como números, también los negativos', () => {
        expect(lines[1]).toBe('Paracetamol,10,120.50,23.50');
        // Pasar -35.5 por la guarda de fórmulas lo volvería texto (`'-35.50`).
        expect(lines[2].endsWith(',2,-35.50,')).toBe(true);
    });

    it('neutraliza fórmulas en texto y entrecomilla las comas', () => {
        expect(lines[2].startsWith('"\'=HYPERLINK(""http://x"")",')).toBe(true);
        expect(lines[3].startsWith('"Jarabe, 120 ml",')).toBe(true);
    });
});

describe('renderXlsx', () => {
    const load = async () => {
        const buffer = await renderXlsx({
            title: 'Utilidad y margen',
            columns,
            data,
            generatedBy: 'Admin',
            generatedAt: new Date('2026-10-13T18:00:00Z'),
        });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
        return workbook.worksheets[0];
    };

    it('escribe título, periodo y encabezado congelado', async () => {
        const sheet = await load();
        expect(sheet.name).toBe('Utilidad y margen');
        expect(sheet.getCell('A1').value).toBe('Utilidad y margen');
        expect(sheet.getCell('A2').value).toBe('Octubre 2026');
        expect(sheet.getRow(4).getCell(3).value).toBe('Utilidad');
        expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    });

    it('guarda números reales con formato y el porcentaje como fracción', async () => {
        const sheet = await load();
        expect(sheet.getCell('C5').value).toBe(120.5);
        expect(sheet.getCell('C5').numFmt).toContain('$');
        expect(sheet.getCell('C6').value).toBe(-35.5);
        expect(sheet.getCell('D5').value).toBeCloseTo(0.235);
        expect(sheet.getCell('D5').numFmt).toBe('0.0%');
        expect(sheet.getCell('D6').value).toBeNull();
    });

    it('suma con fórmula y no ejecuta el texto que parece fórmula', async () => {
        const sheet = await load();
        expect(sheet.getCell('C8').value).toMatchObject({ formula: 'SUM(C5:C7)' });
        expect(sheet.getCell('A6').value).toBe('=HYPERLINK("http://x")');
        expect(sheet.getCell('A6').type).toBe(ExcelJS.ValueType.String);
    });

    it('limpia los caracteres que Excel prohíbe en el nombre de hoja', () => {
        expect(sheetName('Ventas: 1/2 [prueba]?')).toBe('Ventas  1 2  prueba');
        expect(sheetName('x'.repeat(50))).toHaveLength(31);
        expect(sheetName('///')).toBe('Reporte');
    });
});

describe('reportHtml', () => {
    const html = reportHtml({
        title: 'Utilidad',
        columns,
        data,
        generatedBy: 'Admin <script>',
        generatedAt: new Date('2026-10-13T18:00:00Z'),
    });

    it('escapa texto de usuario y notas', () => {
        expect(html).not.toContain('<script>');
        expect(html).toContain('Admin &lt;script&gt;');
        expect(html).toContain('Nota &lt;b&gt;al pie&lt;/b&gt;');
        expect(html).toContain('=HYPERLINK(&quot;http://x&quot;)');
    });

    it('suma los totales en centavos y muestra vacío como raya', () => {
        expect(html).toContain('Total · 3 filas');
        // 120.5 - 35.5 + 0.1 = 85.1, sin 85.10000000000001.
        expect(html).toContain('$85.10');
        expect(html).toContain('<td class="num">—</td>');
    });

    it('sin filas muestra el mensaje y no dibuja tabla', () => {
        const empty = reportHtml({
            title: 'Utilidad',
            columns,
            data: { ...data, rows: [], emptyMessage: 'Nada por aquí.' },
            generatedBy: 'Admin',
            generatedAt: new Date(),
        });
        expect(empty).toContain('Nada por aquí.');
        expect(empty).not.toContain('<table>');
    });
});

describe('resolveReportPeriod', () => {
    const now = new Date('2026-10-13T18:00:00Z');

    it('por defecto toma el mes en curso', () => {
        expect(resolveReportPeriod({}, now)).toMatchObject({ slug: '2026-10' });
    });

    it('un día, un mes o un rango libre', () => {
        expect(resolveReportPeriod({ date: '2026-10-05' }, now).slug).toBe('2026-10-05');
        expect(resolveReportPeriod({ month: '2026-02' }, now).slug).toBe('2026-02');
        const range = resolveReportPeriod({ from: '2026-10-01', to: '2026-10-07' }, now);
        expect(range.slug).toBe('2026-10-01_2026-10-07');
        expect(range.label).toBe('01/10/2026 al 07/10/2026');
    });

    it('rechaza un rango invertido o de más de un año', () => {
        expect(() => resolveReportPeriod({ from: '2026-10-07', to: '2026-10-01' }, now)).toThrow(
            'posterior',
        );
        expect(() => resolveReportPeriod({ from: '2024-01-01', to: '2026-01-01' }, now)).toThrow(
            'El rango máximo es de 93 días',
        );
        expect(
            () => resolveReportPeriod({ from: '2024-01-01', to: '2026-01-01' }, now, 366),
        ).toThrow('El rango máximo es de 366 días');
    });
});

describe('registro de reportes', () => {
    it('cada reporte tiene clave única y columnas coherentes', () => {
        expect(new Set(REPORT_KEYS).size).toBe(REPORT_KEYS.length);
        expect(REPORT_KEYS.length).toBeGreaterThanOrEqual(24);
        for (const definition of REPORT_REGISTRY.values()) {
            const keys = definition.columns.map((column) => column.key);
            expect(new Set(keys).size).toBe(keys.length);
            for (const column of definition.columns) {
                // Sumar texto no tiene sentido y la fila de totales lo ignoraría.
                expect(column.total && column.type === 'text').toBeFalsy();
            }
        }
    });

    it('la query valida formato, fechas y días', () => {
        expect(reportExportQuerySchema.parse({}).format).toBe('pdf');
        expect(reportExportQuerySchema.parse({ format: 'xlsx', days: '30' }).days).toBe(30);
        expect(reportExportQuerySchema.safeParse({ format: 'docx' }).success).toBe(false);
        expect(reportExportQuerySchema.safeParse({ from: '2026-02-31' }).success).toBe(false);
        expect(reportExportQuerySchema.safeParse({ days: '400' }).success).toBe(false);
    });
});

describe('exportReport', () => {
    it('un reporte desconocido es 404', async () => {
        await expect(
            exportReport({
                report: 'no-existe',
                format: 'csv',
                query: {},
                generatedBy: 'Admin',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('el libro de controlados solo lo exporta administrador o gerente', async () => {
        await expect(
            exportReport({
                report: 'libro-controlados',
                format: 'csv',
                query: {},
                generatedBy: 'Caja',
                roleSlug: 'cashier',
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe('impuestos', () => {
    it('agrupa por día y resta la devolución el día en que se reembolsó', async () => {
        const sale = (id: string, iso: string, total: number, base: number, iva: number) => ({
            id,
            total,
            createdAt: at(iso),
            taxSummary: { base, ivaTotal: iva, iepsTotal: 0, taxTotal: iva, total },
        });
        (salesListRepo.listSales as jest.Mock).mockResolvedValue({
            items: [
                sale('a', '2026-10-10T18:00:00Z', 116, 100, 16),
                sale('b', '2026-10-10T19:00:00Z', 58, 50, 8),
                { id: 'old', total: 30, createdAt: at('2026-10-10T20:00:00Z'), taxSummary: null },
            ],
            total: 3,
        });
        (salesRepo.listSaleReturns as jest.Mock).mockResolvedValue([
            {
                createdAt: at('2026-10-11T18:00:00Z'),
                refundTotal: 58,
                taxSummary: { base: 50, ivaTotal: 8, iepsTotal: 0, taxTotal: 8, total: 58 },
            },
        ]);

        const result = await impuestos.load({
            query: { date: '2026-10-10', from: '2026-10-10', to: '2026-10-11' },
            now: new Date('2026-10-13T18:00:00Z'),
            roleSlug: 'admin',
        });

        expect(result.rows).toEqual([
            { date: '10/10/2026', sales: 3, base: 150, ieps: 0, iva: 24, total: 204 },
            { date: '11/10/2026', sales: 0, base: -50, ieps: 0, iva: -8, total: -58 },
        ]);
        expect(result.notes?.join(' ')).toContain('1 ventas anteriores al desglose');
    });
});
