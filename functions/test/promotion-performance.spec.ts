import { Timestamp } from 'firebase-admin/firestore';
import { Promotion, Sale, SaleProductItem } from '../src/types';
import {
    PERFORMANCE_BASELINE_MAX_DAYS,
    buildPromotionPerformance,
    performanceWindows,
    promotionEffectiveEndMs,
} from '../src/utils/promotion-performance';
import { suggestedPercentForExpiry } from '../src/services/promotions.service';

/**
 * Agregación pura del desempeño de una promoción: ventas armadas a mano, sin
 * Firestore. La lectura (qué ventas llegan aquí) se prueba contra el emulador
 * en `promotions-insights.spec.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 25, 18, 0, 0);
const ts = (ms: number) => Timestamp.fromMillis(ms);

const promo = (overrides: Partial<Promotion> = {}): Promotion => ({
    id: 'promo-1',
    name: 'Paracetamol 2x$60',
    rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
    productIds: ['para', 'ibu'],
    startsAt: ts(NOW - 10 * DAY),
    endsAt: null,
    isActive: true,
    deactivatedAt: null,
    createdBy: 'admin',
    updatedBy: 'admin',
    createdAt: ts(NOW - 10 * DAY),
    updatedAt: ts(NOW - 10 * DAY),
    ...overrides,
});

const line = (overrides: Partial<SaleProductItem>): SaleProductItem => ({
    kind: 'product',
    productId: 'para',
    productName: 'Paracetamol',
    quantity: 2,
    unitPrice: 35,
    discountAmount: 10,
    subtotal: 70,
    costAmount: 20,
    batchAllocations: [],
    promotion: {
        promotionId: 'promo-1',
        name: 'Paracetamol 2x$60',
        rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
        discountAmount: 10,
    },
    ...overrides,
} as SaleProductItem);

let seq = 0;
const sale = (items: SaleProductItem[], createdAtMs = NOW - DAY, voided = false): Sale => ({
    id: `sale-${(seq += 1)}`,
    folio: `V-${seq}`,
    items,
    createdAt: ts(createdAtMs),
    voidedAt: voided ? ts(createdAtMs + 1000) : null,
} as unknown as Sale);

/** Partida del mismo producto sin promoción (base o precio normal). */
const plain = (quantity: number, productId = 'para'): SaleProductItem => line({
    productId,
    quantity,
    discountAmount: 0,
    subtotal: quantity * 35,
    promotion: undefined,
});

describe('desempeño de promociones (cálculo puro)', () => {
    describe('ventanas', () => {
        it('el fin efectivo es el primero entre endsAt, la baja y ahora', () => {
            expect(promotionEffectiveEndMs(promo(), NOW)).toBe(NOW);
            expect(promotionEffectiveEndMs(promo({ endsAt: ts(NOW - 2 * DAY) }), NOW))
                .toBe(NOW - 2 * DAY);
            expect(promotionEffectiveEndMs(promo({
                endsAt: ts(NOW - 2 * DAY),
                deactivatedAt: ts(NOW - 5 * DAY),
            }), NOW)).toBe(NOW - 5 * DAY);
            expect(promotionEffectiveEndMs(promo({ endsAt: ts(NOW + 5 * DAY) }), NOW)).toBe(NOW);
        });

        it('días fraccionales a 2 decimales y mínimo 1', () => {
            expect(performanceWindows(promo({ startsAt: ts(NOW - 2.5 * DAY) }), NOW).daysActive)
                .toBe(2.5);
            expect(performanceWindows(promo({ startsAt: ts(NOW - DAY / 3) }), NOW).daysActive)
                .toBe(1);
            // Promo que aún no empieza: sin división entre cero ni días negativos.
            expect(performanceWindows(promo({ startsAt: ts(NOW + DAY) }), NOW).daysActive).toBe(1);
            expect(performanceWindows(promo({ startsAt: ts(NOW - DAY * 10 / 3) }), NOW).daysActive)
                .toBe(3.33);
        });

        it('la base dura lo mismo que la promo, con tope de 90 días', () => {
            const corta = performanceWindows(promo(), NOW);
            expect(corta.baselineDays).toBe(10);
            expect(corta.baselineFromMs).toBe(NOW - 20 * DAY);

            const larga = performanceWindows(promo({ startsAt: ts(NOW - 200 * DAY) }), NOW);
            expect(larga.daysActive).toBe(200);
            expect(larga.baselineDays).toBe(PERFORMANCE_BASELINE_MAX_DAYS);
            expect(larga.baselineFromMs).toBe(NOW - 290 * DAY);
        });
    });

    it('agrega solo partidas con esta promo, en ventas no anuladas', () => {
        const result = buildPromotionPerformance({
            promotion: promo(),
            nowMs: NOW,
            promotionSales: [
                sale([line({}), plain(1, 'otro')]),
                sale([line({
                    quantity: 4, subtotal: 140, discountAmount: 25, costAmount: 40,
                    promotion: { ...line({}).promotion!, discountAmount: 20 },
                })]),
                sale([line({ productId: 'ibu', productName: 'Ibuprofeno' })]),
                // Anulada: no cuenta nada.
                sale([line({ quantity: 10, subtotal: 350 })], NOW - DAY, true),
                // Partida con otra promo en la misma venta: no es de esta.
                sale([line({ promotion: { ...line({}).promotion!, promotionId: 'otra' } })]),
            ],
            baselineSales: [],
        });

        expect(result.salesCount).toBe(3);
        expect(result.unitsSold).toBe(8);
        // Solo la parte de la promo: el 5 manual de la segunda no entra.
        expect(result.discountTotal).toBe(40);
        // subtotal − discountAmount (promo + manual): 60 + 115 + 60.
        expect(result.netRevenue).toBe(235);
        expect(result.costTotal).toBe(80);
        expect(result.grossProfit).toBe(155);
        expect(result.byProduct).toEqual([
            { productId: 'para', productName: 'Paracetamol', unitsSold: 6,
                discountTotal: 30, netRevenue: 175 },
            { productId: 'ibu', productName: 'Ibuprofeno', unitsSold: 2,
                discountTotal: 10, netRevenue: 60 },
        ]);
    });

    it('suma en centavos: 0.1 + 0.2 no deja residuo', () => {
        const centavos = (discount: number) => line({
            quantity: 1, subtotal: 10, discountAmount: discount, costAmount: 0.1,
            promotion: { ...line({}).promotion!, discountAmount: discount },
        });
        const result = buildPromotionPerformance({
            promotion: promo(),
            nowMs: NOW,
            promotionSales: [sale([centavos(0.1)]), sale([centavos(0.2)])],
            baselineSales: [],
        });
        expect(result.discountTotal).toBe(0.3);
        expect(result.netRevenue).toBe(19.7);
        expect(result.costTotal).toBe(0.2);
    });

    it('una partida sin costo deja costo y utilidad en null', () => {
        const result = buildPromotionPerformance({
            promotion: promo(),
            nowMs: NOW,
            promotionSales: [sale([line({})]), sale([line({ costAmount: null })])],
            baselineSales: [],
        });
        expect(result.costTotal).toBeNull();
        expect(result.grossProfit).toBeNull();
        expect(result.netRevenue).toBe(120);
    });

    it('lift contra la ventana previa: mismos productos, sin anuladas ni fuera de rango', () => {
        const result = buildPromotionPerformance({
            promotion: promo(),
            nowMs: NOW,
            promotionSales: [sale([line({ quantity: 6, subtotal: 210 })])],
            baselineSales: [
                sale([plain(2)], NOW - 15 * DAY),
                // Con otra promo también cuenta: es "cuánto se vendía antes".
                sale([
                    line({
                        quantity: 1,
                        promotion: { ...line({}).promotion!, promotionId: 'otra' },
                    }),
                    plain(4, 'ajeno'),
                ], NOW - 12 * DAY),
                sale([plain(5)], NOW - 25 * DAY),
                sale([plain(7)], NOW - 14 * DAY, true),
                sale([plain(9)], NOW - 10 * DAY + 1),
            ],
        });
        expect(result.daysActive).toBe(10);
        expect(result.unitsPerDayDuring).toBe(0.6);
        expect(result.baseline).toEqual({ days: 10, unitsSold: 3, unitsPerDay: 0.3 });
        expect(result.liftPercent).toBe(100);
        expect(result.startsAt).toBe(new Date(NOW - 10 * DAY).toISOString());
        expect(result.effectiveEnd).toBe(new Date(NOW).toISOString());
        expect(result.endsAt).toBeNull();
    });

    it('sin ventas previas el lift es null, no infinito', () => {
        const result = buildPromotionPerformance({
            promotion: promo(),
            nowMs: NOW,
            promotionSales: [sale([line({})])],
            baselineSales: [],
        });
        expect(result.baseline.unitsPerDay).toBe(0);
        expect(result.liftPercent).toBeNull();
    });

    it('promo sin ventas: todo en cero y byProduct vacío', () => {
        const result = buildPromotionPerformance({
            promotion: promo({ endsAt: ts(NOW - 3 * DAY) }),
            nowMs: NOW,
            promotionSales: [],
            baselineSales: [sale([plain(7)], NOW - 11 * DAY)],
        });
        expect(result).toMatchObject({
            salesCount: 0, unitsSold: 0, discountTotal: 0, netRevenue: 0,
            costTotal: 0, grossProfit: 0, unitsPerDayDuring: 0, byProduct: [],
            daysActive: 7, liftPercent: -100,
        });
        expect(result.endsAt).toBe(new Date(NOW - 3 * DAY).toISOString());
    });
});

describe('descuento sugerido por caducidad', () => {
    it.each([
        [1, 30], [30, 30], [31, 20], [60, 20], [61, 10], [90, 10], [180, 10],
    ])('%i días → %i %%', (days, percent) => {
        expect(suggestedPercentForExpiry(days)).toBe(percent);
    });
});
