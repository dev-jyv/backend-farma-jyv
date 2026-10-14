/**
 * Análisis de un producto con un caso cerrado: ventas por mes, margen, precio
 * auditado, stock reconstruido hacia atrás y valor de inventario.
 */

import { Sale } from '../src/types';
import {
    AnalyticsInput,
    addMonths,
    buildProductAnalytics,
} from '../src/services/product-analytics.service';

const at = (iso: string) => ({ toMillis: () => new Date(iso).getTime() });

// 15 de octubre de 2026, mediodía en Ciudad de México.
const now = new Date('2026-10-15T18:00:00.000Z');

const taxes = (baseAmount: number) => ({
    base: baseAmount,
    ivaRate: 0.16,
    ivaAmount: baseAmount * 0.16,
    iepsRate: 0,
    iepsAmount: 0,
});

const priceChange = (iso: string, before: number, after: number) => ({
    createdAt: at(iso),
    changes: { salePrice: { before, after } },
});

const line = (overrides: Record<string, unknown>) => ({
    kind: 'product',
    productId: 'p1',
    productName: 'Paracetamol',
    quantity: 1,
    unitPrice: 116,
    discountAmount: 0,
    subtotal: 116,
    netAmount: 116,
    taxes: { base: 100, ivaRate: 0.16, ivaAmount: 16, iepsRate: 0, iepsAmount: 0 },
    costAmount: 40,
    batchAllocations: [],
    ...overrides,
});

const sale = (iso: string, items: unknown[], voidedAt: string | null = null) => ({
    createdAt: at(iso),
    voidedAt: voidedAt ? at(voidedAt) : null,
    items,
}) as unknown as AnalyticsInput['sales'][number] & Pick<Sale, 'items'>;

const base = (overrides: Partial<AnalyticsInput> = {}): AnalyticsInput => ({
    product: {
        id: 'p1',
        name: 'Paracetamol',
        unit: 'caja',
        salePrice: 128,
        minStock: 5,
        activeIngredient: 'Paracetamol',
        concentration: '500 mg',
        totalStock: 20,
    },
    now,
    months: 3,
    sales: [],
    returns: [],
    movements: [],
    movementsTruncated: false,
    priceLogs: [],
    entries: [],
    batches: [],
    ...overrides,
});

describe('addMonths', () => {
    it('cruza años en ambos sentidos', () => {
        expect(addMonths('2026-01', -1)).toBe('2025-12');
        expect(addMonths('2026-11', 3)).toBe('2027-02');
    });
});

describe('buildProductAnalytics', () => {
    it('suma ventas del mes y del año, sin anuladas ni otros productos', () => {
        const result = buildProductAnalytics(base({
            sales: [
                sale('2026-10-05T18:00:00.000Z', [line({ quantity: 2, netAmount: 232, subtotal: 232,
                    costAmount: 80, taxes: taxes(200) })]),
                sale('2026-10-06T18:00:00.000Z', [line({})], '2026-10-06T19:00:00.000Z'),
                sale('2026-10-07T18:00:00.000Z', [line({ productId: 'otro' })]),
                sale('2026-02-10T18:00:00.000Z', [line({})]),
            ],
        }));

        expect(result.kpis.salesMonth).toMatchObject({
            units: 2, revenue: 232, base: 200, cost: 80, margin: 120, marginRate: 60,
        });
        // Año en curso: octubre + febrero (febrero queda fuera de la ventana de 3 meses).
        expect(result.kpis.salesYear.units).toBe(3);
        expect(result.monthly.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    });

    it('no inventa el margen cuando una venta no tiene costo', () => {
        const result = buildProductAnalytics(base({
            sales: [sale('2026-10-05T18:00:00.000Z', [line({ costAmount: null })])],
        }));

        expect(result.kpis.salesMonth.margin).toBeNull();
        expect(result.kpis.salesMonth.marginRate).toBeNull();
        expect(result.monthly[2].avgCostSold).toBeNull();
    });

    it('resta devoluciones del mes en que ocurrieron', () => {
        const result = buildProductAnalytics(base({
            sales: [sale('2026-09-20T18:00:00.000Z', [
                line({ quantity: 3, netAmount: 348, subtotal: 348, taxes: taxes(300) }),
            ])],
            returns: [{
                createdAt: at('2026-10-02T18:00:00.000Z'),
                items: [{ productId: 'p1', quantity: 1, refundAmount: 116, taxes: { base: 100 } }],
            }],
        }));

        expect(result.monthly[1].units).toBe(3);
        expect(result.monthly[2].units).toBe(-1);
        expect(result.monthly[2].revenue).toBe(-116);
    });

    it('calcula precio promedio ponderado, mínimo y máximo del mes', () => {
        const result = buildProductAnalytics(base({
            sales: [
                sale('2026-10-05T18:00:00.000Z', [line({ quantity: 1, unitPrice: 100 })]),
                sale('2026-10-06T18:00:00.000Z', [line({ quantity: 3, unitPrice: 120 })]),
            ],
        }));

        expect(result.monthly[2]).toMatchObject({ avgPrice: 115, minPrice: 100, maxPrice: 120 });
    });

    it('reconstruye el precio de catálogo mes a mes con los cambios auditados', () => {
        const result = buildProductAnalytics(base({
            priceLogs: [
                priceChange('2026-09-10T18:00:00.000Z', 110, 120),
                priceChange('2026-10-10T18:00:00.000Z', 120, 128),
            ],
        }));

        expect(result.monthly.map((m) => m.catalogPrice)).toEqual([110, 120, 128]);
        expect(result.priceChanges).toHaveLength(2);
    });

    it('reconstruye el stock hacia atrás desde la existencia actual', () => {
        const result = buildProductAnalytics(base({
            // Hoy hay 20: en octubre entraron 10 y se vendieron 4 → al cierre de
            // septiembre había 20 - 10 + 4 = 14.
            movements: [
                { type: 'entry', quantity: 10, createdAt: at('2026-10-03T18:00:00.000Z') },
                { type: 'sale_adjustment', quantity: 4, createdAt: at('2026-10-08T18:00:00.000Z') },
                { type: 'exit_waste', quantity: 2, createdAt: at('2026-09-12T18:00:00.000Z') },
            ],
        }));

        expect(result.monthly[2].endStock).toBe(20);
        expect(result.monthly[1].endStock).toBe(14);
        expect(result.monthly[0].endStock).toBe(16);
    });

    it('marca como desconocido el stock anterior al historial recortado', () => {
        const result = buildProductAnalytics(base({
            movementsTruncated: true,
            movements: [{ type: 'entry', quantity: 10, createdAt: at('2026-09-20T18:00:00.000Z') }],
        }));

        // Agosto cierra antes del movimiento más antiguo leído: no se adivina.
        expect(result.monthly[0].endStock).toBeNull();
        // Septiembre cierra después de esa entrada: no hay nada posterior que deshacer.
        expect(result.monthly[1].endStock).toBe(20);
        expect(result.truncated.movements).toBe(true);
    });

    it('valúa el inventario a costo y a venta y avisa de lotes sin costo', () => {
        const result = buildProductAnalytics(base({
            batches: [
                { quantity: 10, costPrice: 50, expiryDate: at('2027-03-01T00:00:00.000Z') },
                { quantity: 4, expiryDate: at('2027-01-01T00:00:00.000Z') },
                { quantity: 0, costPrice: 99, expiryDate: at('2026-11-01T00:00:00.000Z') },
            ],
        }));

        expect(result.kpis.inventory).toMatchObject({
            units: 14,
            costValue: 500,
            saleValue: 2560,
            unitsWithoutCost: 4,
            batches: 2,
            nextExpiry: '2027-01-01T00:00:00.000Z',
        });
    });

    it('toma el costo de compra más reciente y el promedio ponderado por mes', () => {
        const result = buildProductAnalytics(base({
            entries: [
                { id: 'e2', supplierId: 's1', createdAt: at('2026-10-02T18:00:00.000Z'),
                    items: [{ productId: 'p1', quantity: 10, costPrice: 45, lotNumber: 'B' }] },
                { id: 'e1', supplierId: 's2', createdAt: at('2026-10-01T18:00:00.000Z'),
                    items: [
                        { productId: 'p1', quantity: 10, costPrice: 35 },
                        { productId: 'x', quantity: 1, costPrice: 1 },
                    ] },
            ],
        }));

        expect(result.kpis.lastPurchaseCost).toBe(45);
        expect(result.monthly[2].avgCostPurchased).toBe(40);
        expect(result.purchases.map((p) => p.entryId)).toEqual(['e2', 'e1']);
    });

    it('con un producto sin movimiento devuelve ceros y no revienta', () => {
        const product = { ...base().product, totalStock: undefined };
        const result = buildProductAnalytics(base({ product }));

        expect(result.kpis.salesYear.units).toBe(0);
        expect(result.kpis.salesMonth.margin).toBeNull();
        expect(result.kpis.stock).toBe(0);
        expect(result.monthly.every((m) => m.avgPrice === null)).toBe(true);
    });
});
