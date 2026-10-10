/**
 * Reglas de los indicadores de gestión, con casos cerrados: ABC, horas pico,
 * caducidad, resurtido y clientes que regresan.
 */

import {
    bucketExpiry,
    classifyAbc,
    expiryBucketOf,
    reorderSuggestion,
    summarizeAbc,
    summarizeByHour,
    summarizeCustomers,
} from '../src/services/insights.service';

describe('clasificación ABC', () => {
    const products = [
        { productId: 'c', total: 50 },
        { productId: 'a', total: 700 },
        { productId: 'b', total: 150 },
        { productId: 'd', total: 60 },
        { productId: 'e', total: 40 },
    ];

    it('A hasta el 80 %, B hasta el 95 %, C el resto; el que cruza el umbral se queda', () => {
        const classes = Object.fromEntries(
            classifyAbc(products).map((item) => [item.productId, item.abcClass]),
        );

        // Acumulado previo: a 0 %, b 70 %, d 85 %, c 91 %, e 96 %.
        expect(classes).toEqual({ a: 'A', b: 'A', d: 'B', c: 'B', e: 'C' });
    });

    it('resume conteo, venta y participación por clase', () => {
        const summary = summarizeAbc(classifyAbc(products));

        expect(summary.classes).toEqual([
            { abcClass: 'A', productCount: 2, total: 850, share: 85 },
            { abcClass: 'B', productCount: 2, total: 110, share: 11 },
            { abcClass: 'C', productCount: 1, total: 40, share: 4 },
        ]);
    });

    it('un producto con venta neta cero o negativa es C', () => {
        const classified = classifyAbc([
            { productId: 'x', total: 100 },
            { productId: 'devuelto', total: 0 },
        ]);

        expect(classified.find((item) => item.productId === 'devuelto')?.abcClass).toBe('C');
    });

    it('una utilidad negativa cae en C sin achicar la base de participación', () => {
        const summary = summarizeAbc(
            classifyAbc([
                { productId: 'gana', total: 100 },
                { productId: 'pierde', total: -20 },
            ]),
        );

        expect(summary.classes[0]).toEqual({
            abcClass: 'A', productCount: 1, total: 100, share: 100,
        });
        expect(summary.classes[2]).toEqual({
            abcClass: 'C', productCount: 1, total: -20, share: -20,
        });
    });
});

describe('ventas por hora', () => {
    it('agrupa en hora local de la farmacia, no en UTC', () => {
        const report = summarizeByHour([
            // 15:30 UTC = 09:30 en Ciudad de México (UTC-6), miércoles.
            { createdAt: new Date('2026-03-04T15:30:00Z'), total: 100 },
            { createdAt: new Date('2026-03-04T15:45:00Z'), total: 50.5 },
            // 03:00 UTC del jueves = 21:00 del miércoles local.
            { createdAt: new Date('2026-03-05T03:00:00Z'), total: 20 },
        ]);

        expect(report.byHour[9]).toEqual({ hour: 9, salesCount: 2, total: 150.5 });
        expect(report.byHour[21]).toEqual({ hour: 21, salesCount: 1, total: 20 });
        expect(report.byWeekday[3]).toEqual({ weekday: 3, salesCount: 3, total: 170.5 });
        expect(report.byWeekday[4].salesCount).toBe(0);
    });
});

describe('caducidad', () => {
    it('reparte por días a vencer', () => {
        expect(expiryBucketOf(-1)).toBe('expired');
        expect(expiryBucketOf(0)).toBe('days30');
        expect(expiryBucketOf(30)).toBe('days30');
        expect(expiryBucketOf(31)).toBe('days60');
        expect(expiryBucketOf(90)).toBe('days90');
        expect(expiryBucketOf(91)).toBeNull();
    });

    it('valúa a costo del lote y cuenta los lotes sin costo', () => {
        const asOf = new Date('2026-03-01T12:00:00Z');
        const report = bucketExpiry(
            [
                {
                    id: 'b1', productId: 'p1', lotNumber: 'L1', quantity: 10, costPrice: 12.5,
                    expiryDate: new Date('2026-02-20T00:00:00Z'),
                },
                {
                    id: 'b2', productId: 'p2', lotNumber: 'L2', quantity: 4, costPrice: 30,
                    expiryDate: new Date('2026-03-20T00:00:00Z'),
                },
                {
                    id: 'b3', productId: 'p2', lotNumber: 'L3', quantity: 5,
                    expiryDate: new Date('2026-03-25T00:00:00Z'),
                },
                {
                    id: 'b4', productId: 'p3', lotNumber: 'L4', quantity: 8, costPrice: 5,
                    expiryDate: new Date('2026-12-31T00:00:00Z'),
                },
            ],
            new Map([['p1', 'Paracetamol'], ['p2', 'Amoxicilina']]),
            asOf,
        );

        expect(report.buckets).toEqual([
            { bucket: 'expired', batchCount: 1, quantity: 10, value: 125 },
            { bucket: 'days30', batchCount: 2, quantity: 9, value: 120 },
            { bucket: 'days60', batchCount: 0, quantity: 0, value: 0 },
            { bucket: 'days90', batchCount: 0, quantity: 0, value: 0 },
        ]);
        expect(report.batchesWithoutCost).toBe(1);
        expect(report.items.map((item) => item.batchId)).toEqual(['b1', 'b2', 'b3']);
        expect(report.items[0].productName).toBe('Paracetamol');
    });
});

describe('resurtido sugerido', () => {
    it('cubre los días pedidos de venta promedio', () => {
        expect(
            reorderSuggestion({
                stock: 5, minStock: 2, soldQuantity: 60, windowDays: 30, coverDays: 7,
            }),
        ).toEqual({ averageDaily: 2, daysOfCover: 2.5, suggestedQuantity: 9 });
    });

    it('sin venta, repone hasta el mínimo del catálogo', () => {
        expect(
            reorderSuggestion({
                stock: 1, minStock: 4, soldQuantity: 0, windowDays: 30, coverDays: 7,
            }),
        ).toEqual({ averageDaily: 0, daysOfCover: null, suggestedQuantity: 3 });
    });

    it('con existencia suficiente no sugiere nada', () => {
        expect(
            reorderSuggestion({
                stock: 50, minStock: 4, soldQuantity: 30, windowDays: 30, coverDays: 7,
            }).suggestedQuantity,
        ).toBe(0);
    });
});

describe('clientes que regresan', () => {
    it('cuenta recompra sobre clientes identificados y separa las ventas anónimas', () => {
        const at = (iso: string) => new Date(iso);
        const report = summarizeCustomers([
            { customerId: 'c1', customerName: 'Ana', total: 100, createdAt: at('2026-03-01') },
            { customerId: 'c1', customerName: 'Ana', total: 50, createdAt: at('2026-03-10') },
            { customerId: 'c2', customerName: 'Luis', total: 80, createdAt: at('2026-03-02') },
            { customerId: null, customerName: null, total: 30, createdAt: at('2026-03-03') },
        ]);

        expect(report).toMatchObject({
            identifiedSales: 3,
            anonymousSales: 1,
            customers: 2,
            repeatCustomers: 1,
            repeatRate: 50,
        });
        expect(report.items).toEqual([
            {
                customerId: 'c1',
                customerName: 'Ana',
                purchases: 2,
                total: 150,
                lastPurchaseAt: '2026-03-10T00:00:00.000Z',
            },
        ]);
    });
});
