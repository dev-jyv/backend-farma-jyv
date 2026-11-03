import { computeCouponDiscount, CouponEngineCoupon } from '../src/utils/coupons';
import cases from './coupons-engine.cases.json';

/**
 * Casos dorados del motor de cupones (SPEC 47). `coupons-engine.cases.json` es
 * **idéntico** en backend y POS (lo vigila `npm run check:promo-engine`) y cada
 * repo corre su copia del motor contra él. Se genera con
 * `scripts/generate-coupons-engine-cases.mjs`; no se edita a mano.
 *
 * Incluye formas inválidas a propósito (alcance o tipo desconocido, campos
 * faltantes): una caja con motor viejo recibe cupones que no conoce y debe
 * tratarlos como sin descuento, no tronar. Por eso se castean sin validar.
 */
describe('motor de cupones — casos dorados', () => {
    it('trae al menos 60 casos', () => {
        expect(cases.cases.length).toBeGreaterThanOrEqual(60);
    });

    it.each(cases.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expect(computeCouponDiscount(
            entry.coupon as unknown as CouponEngineCoupon,
            entry.lines,
        )).toEqual(entry.expected);
    });
});

describe('motor de cupones — contrato', () => {
    const lines = [
        { productId: 'a', pieces: 2, netCents: 7000, hasPromotion: false },
        { productId: 'b', pieces: 1, netCents: 6000, hasPromotion: true },
        { productId: 'c', pieces: 1, netCents: 3000, hasPromotion: false },
    ];

    it('producto 10 %: solo partidas elegibles y sin promoción', () => {
        expect(computeCouponDiscount({
            scope: 'product',
            productIds: ['a', 'b'],
            discount: { type: 'percent', percent: 10 },
            minPurchaseCents: null,
        }, lines)).toEqual({ lines: [700, 0, 0], saleCents: 0, totalCents: 700 });
    });

    it('producto por monto: por pieza, con tope en el neto', () => {
        expect(computeCouponDiscount({
            scope: 'product',
            productIds: ['a', 'c'],
            discount: { type: 'amount', amountCents: 4000 },
            minPurchaseCents: null,
        }, lines)).toEqual({ lines: [7000, 0, 3000], saleCents: 0, totalCents: 10000 });
    });

    it('venta: sobre la suma de netos, con mínimo', () => {
        const coupon: CouponEngineCoupon = {
            scope: 'sale',
            productIds: [],
            discount: { type: 'amount', amountCents: 5000 },
            minPurchaseCents: 16000,
        };
        expect(computeCouponDiscount(coupon, lines))
            .toEqual({ lines: [0, 0, 0], saleCents: 5000, totalCents: 5000 });
        expect(computeCouponDiscount({ ...coupon, minPurchaseCents: 16001 }, lines))
            .toEqual({ lines: [0, 0, 0], saleCents: 0, totalCents: 0 });
    });
});
