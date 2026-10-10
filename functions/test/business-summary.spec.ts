/**
 * Resumen semanal/mensual con casos cerrados: periodos locales, comparación
 * "mismos días", cobertura de costo y avisos por reglas.
 */

import {
    SummarySale,
    buildHighlights,
    compareTotals,
    resolvePeriods,
    summarizePeriod,
} from '../src/services/business-summary.service';

const at = (iso: string) => ({ toMillis: () => new Date(iso).getTime() });

const taxes = (base: number) => ({
    base,
    ivaRate: 0.16,
    ivaAmount: base * 0.16,
    iepsRate: 0,
    iepsAmount: 0,
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
    taxes: taxes(100),
    costAmount: 40,
    batchAllocations: [],
    ...overrides,
});

const sale = (iso: string, items: unknown[], total = 116, extra: Record<string, unknown> = {}) => ({
    createdAt: at(iso),
    voidedAt: null,
    paymentMethod: 'cash',
    total,
    costTotal: 40,
    items,
    taxSummary: { base: total / 1.16, ivaTotal: total - total / 1.16 },
    ...extra,
}) as unknown as SummarySale;

const win = (startYmd: string, endYmd: string, days: number) => ({ startYmd, endYmd, days });

describe('resolvePeriods', () => {
    it('semana completa: lunes a domingo y la anterior de 7 días', () => {
        // Miércoles 7 oct 2026 pertenece a la semana del lunes 5 al domingo 11.
        const result = resolvePeriods('week', '2026-10-07', '2026-10-20');

        expect(result.isPartial).toBe(false);
        expect(result.current).toMatchObject(win('2026-10-05', '2026-10-11', 7));
        expect(result.previous).toMatchObject(win('2026-09-28', '2026-10-04', 7));
    });

    it('semana en curso: compara contra los mismos días de la anterior', () => {
        // Hoy miércoles 14 oct: lunes a miércoles = 3 días.
        const result = resolvePeriods('week', '2026-10-14', '2026-10-14');

        expect(result.isPartial).toBe(true);
        expect(result.current).toMatchObject(win('2026-10-12', '2026-10-14', 3));
        expect(result.previous).toMatchObject(win('2026-10-05', '2026-10-07', 3));
    });

    it('mes en curso: los primeros N días del mes anterior', () => {
        const result = resolvePeriods('month', '2026-10-10', '2026-10-10');

        expect(result.current).toMatchObject(win('2026-10-01', '2026-10-10', 10));
        expect(result.previous).toMatchObject(win('2026-09-01', '2026-09-10', 10));
    });

    it('mes cerrado cruzando año y sin invadir el periodo actual', () => {
        const result = resolvePeriods('month', '2026-01-15', '2026-03-31');

        expect(result.current).toMatchObject(win('2026-01-01', '2026-01-31', 31));
        expect(result.previous).toMatchObject(win('2025-12-01', '2025-12-31', 31));
    });

    it('mes en curso largo contra un mes anterior corto no invade el actual', () => {
        const result = resolvePeriods('month', '2026-03-31', '2026-03-31');

        expect(result.previous).toMatchObject(win('2026-02-01', '2026-02-28', 28));
    });

    it('corrige un ancla futura a hoy', () => {
        const result = resolvePeriods('week', '2027-01-01', '2026-10-14');

        expect(result.current.startYmd).toBe('2026-10-12');
    });

    it('los límites de consulta son hora local de la farmacia (UTC-6)', () => {
        const { current } = resolvePeriods('week', '2026-10-07', '2026-10-20');

        expect(current.from).toBe('2026-10-05T06:00:00.000Z');
        expect(current.to).toBe('2026-10-12T05:59:59.999Z');
    });
});

describe('summarizePeriod', () => {
    it('suma tickets, bruto, devoluciones y neto; ignora anuladas', () => {
        const totals = summarizePeriod(
            [
                sale('2026-10-05T18:00:00.000Z', [line({})], 116),
                sale('2026-10-06T18:00:00.000Z', [line({ quantity: 2, subtotal: 232, netAmount: 232,
                    taxes: taxes(200), costAmount: 80 })], 232),
                sale('2026-10-06T19:00:00.000Z', [line({})], 116, {
                    voidedAt: at('2026-10-06T20:00:00.000Z'),
                }),
            ],
            [{ refundTotal: 116, taxSummary: { base: 100 } }],
        );

        expect(totals).toMatchObject({
            tickets: 2, gross: 348, refunds: 116, net: 232, ticketAverage: 174,
        });
        expect(totals.byDay.map((day) => day.date)).toEqual(['2026-10-05', '2026-10-06']);
    });

    it('calcula utilidad y margen solo sobre lo que tiene costo', () => {
        const totals = summarizePeriod(
            [
                sale('2026-10-05T18:00:00.000Z', [
                    line({ productId: 'a', costAmount: 40 }),
                    line({ productId: 'b', productName: 'Sin costo', costAmount: null }),
                ], 232),
            ],
            [],
        );

        // Base total 200; con costo 100 → utilidad 60 (60 %), cobertura 50 %.
        expect(totals.merchandise).toMatchObject({
            base: 200,
            cost: 40,
            profit: 60,
            marginRate: 60,
            costCoverage: 50,
            ticketsWithoutCost: 1,
            uncostedBase: 100,
        });
        expect(totals.uncostedProducts.map((item) => item.productId)).toEqual(['b']);
    });

    it('sin ninguna partida con costo no inventa un margen', () => {
        const totals = summarizePeriod(
            [sale('2026-10-05T18:00:00.000Z', [line({ costAmount: null })])],
            [],
        );

        expect(totals.merchandise.marginRate).toBeNull();
        expect(totals.merchandise.costCoverage).toBe(0);
    });

    it('ordena los productos por importe y calcula su participación', () => {
        const totals = summarizePeriod(
            [sale('2026-10-05T18:00:00.000Z', [
                line({ productId: 'a', productName: 'A', netAmount: 300, subtotal: 300,
                    taxes: taxes(260) }),
                line({ productId: 'b', productName: 'B', netAmount: 100, subtotal: 100,
                    taxes: taxes(86) }),
            ], 400)],
            [],
        );

        expect(totals.topProducts.map((item) => item.productId)).toEqual(['a', 'b']);
        expect(totals.topProducts[0].share).toBe(75);
    });

    it('un periodo vacío devuelve ceros', () => {
        const totals = summarizePeriod([], []);

        expect(totals).toMatchObject({ tickets: 0, gross: 0, net: 0, ticketAverage: 0 });
        expect(totals.merchandise.costCoverage).toBeNull();
    });
});

describe('compareTotals y buildHighlights', () => {
    const totalsOf = (net: number, tickets: number) => {
        const sales = Array.from({ length: tickets }, (_, i) =>
            sale(`2026-10-0${(i % 9) + 1}T18:00:00.000Z`, [line({})], net / tickets));
        return summarizePeriod(sales, []);
    };

    it('compara con el periodo anterior y deja null sin base', () => {
        const comparison = compareTotals(totalsOf(1200, 10), totalsOf(1000, 8));

        expect(comparison.net).toBe(20);
        expect(comparison.tickets).toBe(25);
        expect(compareTotals(totalsOf(500, 5), summarizePeriod([], [])).net).toBeNull();
    });

    it('avisa de una caída fuerte de ventas y de la baja cobertura de costo', () => {
        const current = summarizePeriod([
            sale('2026-10-05T18:00:00.000Z', [line({ costAmount: null })], 100),
        ], []);
        const previous = totalsOf(1000, 5);
        const codes = buildHighlights(current, compareTotals(current, previous)).map((h) => h.code);

        expect(codes).toContain('salesDown');
        expect(codes).toContain('lowCostCoverage');
    });

    it('un periodo sin ventas solo avisa que no hubo ventas', () => {
        const empty = summarizePeriod([], []);

        expect(buildHighlights(empty, compareTotals(empty, empty)).map((h) => h.code))
            .toEqual(['noSales']);
    });
});
