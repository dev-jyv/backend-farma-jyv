/**
 * Análisis de un servicio del consultorio con un caso cerrado: ventas por mes,
 * precio cobrado, comisiones y reparto por doctor.
 */

import {
    ServiceAnalyticsInput,
    buildServiceAnalytics,
} from '../src/services/service-analytics.service';

const at = (iso: string) => ({ toMillis: () => new Date(iso).getTime() });

// 15 de octubre de 2026, mediodía en Ciudad de México.
const now = new Date('2026-10-15T18:00:00.000Z');

const serviceLine = (overrides: Record<string, unknown> = {}) => ({
    kind: 'service',
    serviceId: 's1',
    serviceName: 'Consulta general',
    providerId: 'd1',
    providerName: 'Dra. Ana',
    commissionRate: 40,
    commissionAmount: 40,
    quantity: 1,
    unitPrice: 100,
    discountAmount: 0,
    subtotal: 100,
    netAmount: 100,
    ...overrides,
});

const sale = (iso: string, items: unknown[], voidedAt: string | null = null) => ({
    createdAt: at(iso),
    voidedAt: voidedAt ? at(voidedAt) : null,
    items,
}) as unknown as ServiceAnalyticsInput['sales'][number];

const input = (sales: ServiceAnalyticsInput['sales'], months = 3): ServiceAnalyticsInput => ({
    service: {
        id: 's1',
        code: 'CONS',
        name: 'Consulta general',
        price: 100,
        commissionRate: 40,
        requiresPerformer: true,
        isActive: true,
        serviceType: 'consultation',
    },
    now,
    months,
    sales,
});

describe('buildServiceAnalytics', () => {
    it('suma ventas, comisión y neto del mes y del año; ignora anuladas y otros servicios', () => {
        const result = buildServiceAnalytics(input([
            sale('2026-10-05T18:00:00.000Z', [serviceLine({ quantity: 2, netAmount: 200,
                subtotal: 200, commissionAmount: 80 })]),
            sale('2026-10-06T18:00:00.000Z', [serviceLine()], '2026-10-06T19:00:00.000Z'),
            sale('2026-10-07T18:00:00.000Z', [serviceLine({ serviceId: 'otro' })]),
            sale('2026-02-10T18:00:00.000Z', [serviceLine()]),
        ]));

        expect(result.kpis.salesMonth).toEqual({
            units: 2, revenue: 200, commission: 80, net: 120,
        });
        // Año en curso: octubre + febrero (febrero queda fuera de la ventana de 3 meses).
        expect(result.kpis.salesYear.units).toBe(3);
        expect(result.monthly.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    });

    it('calcula precio promedio ponderado, mínimo y máximo por mes', () => {
        const result = buildServiceAnalytics(input([
            sale('2026-10-05T18:00:00.000Z', [serviceLine({ unitPrice: 100 })]),
            sale('2026-10-06T18:00:00.000Z', [serviceLine({ unitPrice: 120, quantity: 3 })]),
        ]));

        expect(result.monthly[2]).toMatchObject({ avgPrice: 115, minPrice: 100, maxPrice: 120 });
    });

    it('reparte por doctor y separa los servicios cobrados sin doctor', () => {
        const result = buildServiceAnalytics(input([
            sale('2026-10-05T18:00:00.000Z', [
                serviceLine(),
                serviceLine({ providerId: 'd2', providerName: 'Dr. Luis', netAmount: 300,
                    subtotal: 300, commissionAmount: 120 }),
                serviceLine({ providerId: null, providerName: null, commissionAmount: 0 }),
            ]),
        ]));

        expect(result.byProvider.map((p) => [p.providerId, p.revenue, p.commission])).toEqual([
            ['d2', 300, 120],
            ['d1', 100, 40],
            [null, 100, 0],
        ]);
    });

    it('un servicio sin ventas devuelve ceros y no revienta', () => {
        const result = buildServiceAnalytics(input([]));

        expect(result.kpis.salesYear).toEqual({ units: 0, revenue: 0, commission: 0, net: 0 });
        expect(result.monthly.every((m) => m.avgPrice === null)).toBe(true);
        expect(result.byProvider).toEqual([]);
    });

    it('expone el precio y la comisión vigentes del catálogo', () => {
        const result = buildServiceAnalytics(input([]));

        expect(result.kpis).toMatchObject({ currentPrice: 100, commissionRate: 40 });
        expect(result.service).toMatchObject({ id: 's1', requiresPerformer: true });
    });

    it('agrega la serie por día solo si se pide, con las cubetas vacías en cero', () => {
        const sales = [
            sale('2026-10-14T18:00:00.000Z', [serviceLine({ quantity: 2, netAmount: 200,
                subtotal: 200, commissionAmount: 80 })]),
            sale('2026-10-15T01:00:00.000Z', [serviceLine()]),
        ];

        expect(buildServiceAnalytics(input(sales)).series).toBeUndefined();

        const result = buildServiceAnalytics({
            ...input(sales),
            series: { granularity: 'day', periods: 3 },
        });
        expect(result.granularity).toBe('day');
        expect(result.series?.map((point) => point.bucket))
            .toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
        // 01:00Z del 15 sigue siendo el 14 en Ciudad de México.
        expect(result.series?.map((point) => point.units)).toEqual([0, 3, 0]);
        expect(result.series?.[1]).toMatchObject({ revenue: 300, commission: 120, net: 180 });
        expect(result.series?.[0].avgPrice).toBeNull();
    });

    it('agrupa la serie por semana desde el lunes', () => {
        const result = buildServiceAnalytics({
            ...input([
                sale('2026-10-05T18:00:00.000Z', [serviceLine()]),
                sale('2026-10-11T18:00:00.000Z', [serviceLine()]),
                sale('2026-10-12T18:00:00.000Z', [serviceLine()]),
            ]),
            series: { granularity: 'week', periods: 3 },
        });

        expect(result.series?.map((point) => point.bucket))
            .toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
        expect(result.series?.map((point) => point.units)).toEqual([0, 2, 1]);
    });
});
