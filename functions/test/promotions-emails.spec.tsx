import { Timestamp } from 'firebase-admin/firestore';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromotionsMaintenanceEmail } from '../src/emails/promotions-maintenance.email';
import { PromotionsRetiredEmail } from '../src/emails/promotions-retired.email';
import { SalesReportEmail } from '../src/emails/sales-report.email';
import { describePromotionRule } from '../src/emails/components/promotion-text';
import { DailySalesReport } from '../src/services/sales-reports.service';
import { Promotion, PromotionPerformance } from '../src/types';

/**
 * Correos de promociones y la sección de ventas por revisar del reporte. Se
 * renderizan de verdad (como `inventory-alerts-email.spec.tsx`): lo que se fija
 * es qué ve quien los abre, no la forma del componente.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 25, 13, 0, 0);

const promo = (overrides: Partial<Promotion>): Promotion => ({
    id: 'p1',
    name: 'Paracetamol 2x$60',
    rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
    productIds: ['a', 'b'],
    startsAt: Timestamp.fromMillis(NOW - 10 * DAY),
    endsAt: Timestamp.fromMillis(NOW - DAY),
    isActive: false,
    deactivatedAt: Timestamp.fromMillis(NOW),
    createdBy: 'admin',
    updatedBy: 'system',
    createdAt: Timestamp.fromMillis(NOW - 10 * DAY),
    updatedAt: Timestamp.fromMillis(NOW),
    ...overrides,
});

const performance: PromotionPerformance = {
    promotionId: 'p1',
    name: 'Paracetamol 2x$60',
    startsAt: new Date(NOW - 10 * DAY).toISOString(),
    endsAt: new Date(NOW - DAY).toISOString(),
    effectiveEnd: new Date(NOW - DAY).toISOString(),
    daysActive: 9,
    salesCount: 12,
    unitsSold: 30,
    discountTotal: 150,
    netRevenue: 900,
    costTotal: 300,
    grossProfit: 600,
    unitsPerDayDuring: 3.33,
    baseline: { days: 9, unitsSold: 15, unitsPerDay: 1.67 },
    liftPercent: 100,
    byProduct: [{
        productId: 'a',
        productName: 'Paracetamol 500mg',
        unitsSold: 30,
        discountTotal: 150,
        netRevenue: 900,
    }],
};

describe('correos de promociones', () => {
    it('describe la regla como en el mostrador', () => {
        expect(describePromotionRule({ type: 'tiered', tiers: [{ quantity: 2, price: 60 }] }))
            .toContain('2 por');
        expect(describePromotionRule({ type: 'nxm', buy: 2, pay: 1 })).toBe('2x1');
        expect(describePromotionRule({ type: 'percent', percent: 30, minQty: 1 }))
            .toBe('30 % de descuento');
        expect(describePromotionRule({ type: 'percent', percent: 10, minQty: 3 }))
            .toBe('10 % desde 3 piezas');
    });

    it('mantenimiento: cerradas con desempeño y por terminar', () => {
        const html = renderToStaticMarkup(PromotionsMaintenanceEmail({
            closed: [
                { promotion: promo({}), performance },
                { promotion: promo({ id: 'p2', name: 'Sin datos' }), performance: null },
            ],
            endingSoon: [promo({
                id: 'p3',
                name: 'Ibuprofeno 3x2',
                rule: { type: 'nxm', buy: 3, pay: 2 },
                isActive: true,
                endsAt: Timestamp.fromMillis(NOW + 5 * 60 * 60 * 1000),
                deactivatedAt: null,
            })],
        }));

        expect(html).toContain('Promociones del día');
        expect(html).toContain('Ibuprofeno 3x2');
        expect(html).toContain('Por terminar');
        expect(html).toContain('Paracetamol 2x$60');
        expect(html).toContain('+100.0 %');
        expect(html).toContain('3.33 vs 1.67');
        expect(html).toContain('Paracetamol 500mg');
        expect(html).toContain('No se pudo calcular su desempeño');
    });

    it('mantenimiento sin ventas previas no inventa un porcentaje', () => {
        const html = renderToStaticMarkup(PromotionsMaintenanceEmail({
            closed: [{
                promotion: promo({}),
                performance: { ...performance, liftPercent: null, grossProfit: null },
            }],
            endingSoon: [],
        }));
        expect(html).toContain('sin ventas previas');
        expect(html).toContain('sin costo');
        expect(html).not.toContain('Por terminar');
    });

    it('baja por precio: qué promo, por qué y qué hacer', () => {
        const html = renderToStaticMarkup(PromotionsRetiredEmail({
            product: { name: 'Paracetamol 500mg', salePrice: 61 },
            retired: [{
                id: 'p1',
                name: 'Paracetamol 2x$60',
                ruleText: '2 por $60.00',
                problem: '2 piezas por $60 no es menor al precio normal',
            }],
        }));
        expect(html).toContain('Paracetamol 500mg ahora cuesta');
        expect(html).toContain('Paracetamol 2x$60');
        expect(html).toContain('no es menor al precio normal');
        expect(html).toContain('créala de nuevo');
    });
});

describe('reporte de ventas: promociones por revisar', () => {
    const report = (folios: string[]): DailySalesReport => ({
        kind: 'daily',
        title: 'Reporte diario de ventas',
        periodLabel: '24/09/2026',
        totals: {
            salesCount: 0,
            totalAmount: 0,
            byPaymentMethod: [],
            voidedCount: 0,
            voidedAmount: 0,
            promotionSalesCount: 0,
            promotionDiscountTotal: 0,
        },
        branches: {
            pharmacy: { salesCount: 0, total: 0, share: 0 },
            services: { salesCount: 0, total: 0, share: 0, commissionTotal: 0 },
        },
        expenses: { total: 0, count: 0, byCategory: [] },
        expenseRows: [],
        refundTotal: 0,
        netResult: 0,
        ticketAverage: 0,
        sales: [],
        topProducts: [],
        promotionReview: { count: folios.length, folios },
    });

    it('lista folios e invita a revisarlas en el historial del admin', () => {
        const html = renderToStaticMarkup(SalesReportEmail({
            report: report(['V-000010', 'V-000011']),
        }));
        expect(html).toContain('Ventas con promoción por revisar (2)');
        expect(html).toContain('V-000010, V-000011');
        expect(html).toContain('historial de ventas del admin');
    });

    it('corta la lista larga y dice cuántas faltan', () => {
        const folios = Array.from({ length: 25 }, (_, index) => `V-${index}`);
        const html = renderToStaticMarkup(SalesReportEmail({ report: report(folios) }));
        expect(html).toContain('V-19 y 5 más');
        expect(html).not.toContain('V-20');
    });

    it('sin ventas por revisar no aparece la sección', () => {
        const html = renderToStaticMarkup(SalesReportEmail({ report: report([]) }));
        expect(html).not.toContain('por revisar');
    });
});
