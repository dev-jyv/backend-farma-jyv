/**
 * PDFs del módulo de Reportes: qué partidas cuenta cada ámbito, que cada venta
 * diga quién la cobró y a qué hora, y que el HTML no deje pasar texto sin escapar.
 */

import {
    buildExpenseRows,
    buildExpiryRows,
    buildInventoryRows,
    buildLowStockRows,
    buildNoCostRows,
    expensesReportHtml,
    expiryReportHtml,
    lowStockReportHtml,
    noCostReportHtml,
    buildSalesRows,
    dayRange,
    inventoryReportHtml,
    invoicesReportHtml,
    monthRange,
    periodBounds,
    salesReportHtml,
} from '../src/services/module-reports.service';
import { dailySalesExportQuerySchema } from '../src/schemas';
import type { CashMovement, Sale } from '../src/types';

const at = (iso: string) => {
    const date = new Date(iso);
    return { toMillis: () => date.getTime(), toDate: () => date };
};

const product = (overrides: Record<string, unknown> = {}) => ({
    kind: 'product',
    productId: 'p1',
    productName: 'Paracetamol',
    quantity: 2,
    unitPrice: 30,
    discountAmount: 0,
    subtotal: 60,
    netAmount: 60,
    ...overrides,
});

const service = (overrides: Record<string, unknown> = {}) => ({
    kind: 'service',
    serviceId: 's1',
    serviceName: 'Consulta general',
    providerId: 'd1',
    providerName: 'Dra. Ana',
    quantity: 1,
    unitPrice: 100,
    discountAmount: 0,
    subtotal: 100,
    netAmount: 100,
    ...overrides,
});

const sale = (iso: string, items: unknown[], overrides: Record<string, unknown> = {}) => ({
    id: iso,
    folio: `F-${iso.slice(8, 10)}`,
    createdAt: at(iso),
    voidedAt: null,
    cashierId: 'u1',
    paymentMethod: 'cash',
    total: 160,
    items,
    ...overrides,
}) as unknown as Sale;

const names = new Map([['u1', 'Luis Pérez']]);

describe('buildSalesRows', () => {
    // 14 de octubre de 2026, 20:44 en Ciudad de México.
    const mixed = sale('2026-10-15T02:44:00.000Z', [product(), service()]);

    it('farmacia cuenta solo mercancía y clínica solo servicios, con el importe de su parte', () => {
        const [pharmacy] = buildSalesRows([mixed], 'pharmacy', names);
        const [clinic] = buildSalesRows([mixed], 'clinic', names);
        const [financial] = buildSalesRows([mixed], 'financial', names);

        expect(pharmacy).toMatchObject({ concept: '2× Paracetamol', amount: 60 });
        expect(clinic).toMatchObject({ concept: 'Consulta general (Dra. Ana)', amount: 100 });
        expect(financial).toMatchObject({ amount: 160 });
        expect(financial.concept).toContain('Paracetamol');
        expect(financial.concept).toContain('Consulta general');
    });

    it('cada fila dice quién cobró y a qué hora, en hora de la farmacia', () => {
        const [row] = buildSalesRows([mixed], 'financial', names);

        expect(row.cashier).toBe('Luis Pérez');
        expect(row.date).toBe('14/10/2026');
        expect(row.time).toMatch(/^08:44/);
        expect(row.folio).toBe('F-15');
    });

    it('un cajero que no se resuelve se marca, no se inventa', () => {
        const [row] = buildSalesRows([mixed], 'financial', new Map());

        expect(row.cashier).toBe('Sin identificar');
    });

    it('omite anuladas y ventas sin partidas del ámbito, y ordena por hora', () => {
        const rows = buildSalesRows([
            sale('2026-10-15T20:00:00.000Z', [product({ productName: 'Tarde' })]),
            sale('2026-10-15T16:00:00.000Z', [service()]),
            sale('2026-10-15T17:00:00.000Z', [product()], { voidedAt: at('2026-10-15T18:00:00.000Z') }),
            sale('2026-10-15T15:00:00.000Z', [product({ productName: 'Temprano' })]),
        ], 'pharmacy', names);

        expect(rows.map((row) => row.concept)).toEqual(['2× Temprano', '2× Tarde']);
    });
});

describe('HTML de los reportes', () => {
    const generatedAt = new Date('2026-10-15T18:00:00.000Z');

    it('escapa texto de usuario y deja el generador y el total a la vista', () => {
        const html = salesReportHtml({
            scope: 'pharmacy',
            kind: 'daily',
            range: dayRange('2026-10-15'),
            rows: [{
                date: '15/10/2026', time: '12:00 p. m.', folio: 'F-1', cashier: '<b>Luis</b>',
                payment: 'Efectivo', concept: '1× Jarabe & tos', amount: 50,
            }],
            generatedBy: 'Admin "Uno"',
            generatedAt,
        });

        expect(html).toContain('&lt;b&gt;Luis&lt;/b&gt;');
        expect(html).toContain('Jarabe &amp; tos');
        expect(html).toContain('Generado por Admin &quot;Uno&quot;');
        expect(html).toContain('Ventas del día · Farmacia');
        expect(html).toContain('Total · 1 ventas');
    });

    it('el mensual agrega el resumen por día y un mes vacío lo dice', () => {
        const range = monthRange('2026-10');
        const empty = salesReportHtml({
            scope: 'clinic', kind: 'monthly', range, rows: [], generatedBy: 'A', generatedAt,
        });
        const full = salesReportHtml({
            scope: 'clinic', kind: 'monthly', range, generatedBy: 'A', generatedAt,
            rows: [{ date: '01/10/2026', time: '9:00', folio: 'F', cashier: 'X', payment: 'Efectivo', concept: 'c', amount: 10 }],
        });

        expect(empty).toContain('Sin ventas registradas en el mes');
        expect(full).toContain('Resumen por día');
        expect(range.label.toLowerCase()).toContain('octubre');
    });

    it('lista las facturas con proveedor, fecha, número y quién la registró', () => {
        const html = invoicesReportHtml({
            range: monthRange('2026-10'),
            rows: [{
                supplier: 'Nadro', date: '03/10/2026', number: 'A-123',
                registeredBy: 'Luis', registeredAt: '03/10/2026 10:00 a. m.',
            }],
            generatedBy: 'Admin',
            generatedAt,
        });

        for (const text of ['Nadro', '03/10/2026', 'A-123', 'Luis']) {
            expect(html).toContain(text);
        }
    });
});

describe('inventario', () => {
    it('suma existencia y valor por producto, marca lotes sin costo y ordena por nombre', () => {
        const rows = buildInventoryRows(
            [
                { id: 'b', name: 'Zinc', sku: 'Z', salePrice: 20, minStock: 5 },
                { id: 'a', name: 'Aspirina', sku: 'A', salePrice: 10, minStock: 2 },
            ],
            [
                { productId: 'a', quantity: 3, costPrice: 4 },
                { productId: 'a', quantity: 2 },
            ],
        );

        expect(rows.map((row) => row.name)).toEqual(['Aspirina', 'Zinc']);
        expect(rows[0]).toMatchObject({ stock: 5, costValue: 12, missingCost: true, retailValue: 50 });
        expect(rows[1]).toMatchObject({ stock: 0, costValue: 0, retailValue: 0 });

        const html = inventoryReportHtml({
            rows, generatedBy: 'Admin', generatedAt: new Date('2026-10-15T18:00:00.000Z'),
        });
        expect(html).toContain('Inventario · Farmacia');
        expect(html).toContain('class="num low">0</td>');
    });
});

describe('parámetros de exportación', () => {
    it('acepta una fecha real y rechaza las que no existen en el calendario', () => {
        const parse = (date?: string) =>
            dailySalesExportQuerySchema.safeParse({ scope: 'pharmacy', date });

        expect(parse('2026-10-15').success).toBe(true);
        expect(parse(undefined).success).toBe(true);
        for (const invalid of ['2026-02-31', '9999-99-99', '2026-13-45', '2026-4-5']) {
            expect(parse(invalid).success).toBe(false);
        }
    });
});

describe('stock bajo, caducidad, sin costo y gastos', () => {
    const generatedAt = new Date('2026-10-15T18:00:00.000Z');
    const products = [
        { id: 'a', name: 'Aspirina', sku: 'A', salePrice: 10, minStock: 5 },
        { id: 'b', name: 'Zinc', sku: 'Z', salePrice: 20, minStock: 4 },
        { id: 'c', name: 'Vitamina', sku: 'V', salePrice: 30, minStock: 2 },
    ];

    it('stock bajo: solo en o bajo el mínimo, el agotado primero y con su faltante', () => {
        const rows = buildLowStockRows(products, [
            { productId: 'a', quantity: 3, costPrice: 1 },
            { productId: 'c', quantity: 10, costPrice: 1 },
        ]);

        expect(rows.map((row) => row.name)).toEqual(['Zinc', 'Aspirina']);
        expect(rows[0]).toMatchObject({ stock: 0, missing: 4 });
        expect(rows[1]).toMatchObject({ stock: 3, missing: 2 });
        expect(lowStockReportHtml({ rows, generatedBy: 'A', generatedAt })).toContain('1 agotados');
    });

    it('stock bajo: un producto sin mínimo configurado no cuenta aunque esté en cero', () => {
        const rows = buildLowStockRows(
            [...products, { id: 'd', name: 'Descontinuado', sku: 'D', salePrice: 5, minStock: 0 }],
            [],
        );

        expect(rows.map((row) => row.name)).toEqual(['Aspirina', 'Vitamina', 'Zinc']);
    });

    it('periodBounds: sin fechas, el mes en curso hasta ahora', () => {
        const now = new Date('2026-10-15T18:00:00.000Z');
        const { from, to } = periodBounds(undefined, undefined, now);

        expect(from).toBe('2026-10-01T06:00:00.000Z');
        expect(to).toBe(now.toISOString());
    });

    it('periodBounds: un `to` en un mes anterior arranca ese mes, no el en curso', () => {
        const { from, to } = periodBounds(undefined, '2026-09-05', new Date('2026-10-15T18:00:00.000Z'));

        expect(from).toBe('2026-09-01T06:00:00.000Z');
        expect(to).toBe('2026-09-06T05:59:59.999Z');
    });

    it('periodBounds: ignora días imposibles y rechaza un rango invertido', () => {
        const now = new Date('2026-10-15T18:00:00.000Z');

        expect(periodBounds('2026-02-31', undefined, now).from).toBe('2026-10-01T06:00:00.000Z');
        expect(() => periodBounds('2026-10-10', '2026-10-01', now)).toThrow('posterior');
    });

    it('próximos a caducar: vencidos y hasta 90 días, ordenados, sin lotes vacíos ni lejanos', () => {
        const at = (iso: string) => {
            const date = new Date(iso);
            return { toMillis: () => date.getTime(), toDate: () => date };
        };
        const rows = buildExpiryRows(products, [
            { productId: 'a', lotNumber: 'L2', quantity: 4, expiryDate: at('2026-11-20T12:00:00Z') },
            { productId: 'b', lotNumber: 'L1', quantity: 2, expiryDate: at('2026-10-01T12:00:00Z') },
            { productId: 'c', lotNumber: 'L3', quantity: 9, expiryDate: at('2027-06-01T12:00:00Z') },
            { productId: 'a', lotNumber: 'L4', quantity: 0, expiryDate: at('2026-10-20T12:00:00Z') },
        ], generatedAt);

        expect(rows.map((row) => row.lot)).toEqual(['L1', 'L2']);
        expect(rows[0]).toMatchObject({ status: 'Vencido', quantity: 2 });
        expect(rows[0].daysLeft).toBeLessThan(0);
        expect(rows[1].status).toBe('60 días');
        expect(expiryReportHtml({ rows, generatedBy: 'A', generatedAt })).toContain('1 vencidos');
    });

    it('sin costo: productos con existencia en lotes sin costo, el de más unidades primero', () => {
        const rows = buildNoCostRows(products, [
            { productId: 'a', quantity: 3 },
            { productId: 'a', quantity: 2, costPrice: 4 },
            { productId: 'b', quantity: 7, costPrice: null },
            { productId: 'c', quantity: 5, costPrice: 9 },
            { productId: 'c', quantity: 0 },
        ]);

        expect(rows.map((row) => row.name)).toEqual(['Zinc', 'Aspirina']);
        expect(rows[1]).toMatchObject({ stock: 5, unitsWithoutCost: 3, lotsWithoutCost: 1 });
        expect(noCostReportHtml({ rows: [], generatedBy: 'A', generatedAt }))
            .toContain('tienen costo capturado');
    });

    it('gastos: fecha del gasto, hora de captura, quién lo registró y total por categoría', () => {
        const at = (iso: string) => {
            const date = new Date(iso);
            return { toMillis: () => date.getTime(), toDate: () => date };
        };
        const expense = (overrides: Record<string, unknown>) => ({
            id: 'm',
            type: 'expense',
            amount: 100,
            reason: 'Renta',
            category: 'rent',
            createdBy: 'u1',
            createdAt: at('2026-10-05T16:30:00.000Z'),
            ...overrides,
        }) as unknown as CashMovement;

        const rows = buildExpenseRows([
            expense({ amount: 250, reason: 'Luz', category: 'electricity', occurredAt: at('2026-09-30T16:00:00.000Z') }),
            expense({ createdByLabel: 'Ana (caja)' }),
        ], new Map([['u1', 'Luis Pérez']]));

        expect(rows[0]).toMatchObject({ date: '30/09/2026', createdBy: 'Luis Pérez', payment: 'Efectivo' });
        expect(rows[1]).toMatchObject({ createdBy: 'Ana (caja)', concept: 'Renta' });
        expect(rows[1].time).toMatch(/^10:30/);

        const html = expensesReportHtml({
            range: monthRange('2026-10'), rows, generatedBy: 'A', generatedAt,
        });
        expect(html).toContain('Por categoría');
        expect(html).toContain('Total · 2 gastos');
    });
});
