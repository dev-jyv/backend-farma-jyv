/**
 * Motor de cupones (SPEC 47). **Puro y en centavos**, igual que el de
 * promociones: la caja calcula sin red con su copia y el servidor recalcula al
 * registrar. La copia del POS (`shared/utils/coupons.ts`) se prueba con el
 * mismo archivo de casos dorados (`test/coupons-engine.cases.json`, idéntico
 * byte a byte; lo vigila `npm run check:promo-engine`). Si se cambia uno, se
 * cambian los dos.
 *
 * - `product`: en cada partida cuyo producto está en `productIds` y que **no**
 *   lleva promoción, `percent` del neto de la partida, o `amountCents` por
 *   pieza; nunca más que el neto de la partida.
 * - `sale`: sobre la suma de los netos (subtotal menos descuentos de partida);
 *   si no llega a `minPurchaseCents`, da 0. `percent` de esa base, o
 *   `amountCents` con tope en la base.
 *
 * Una forma que este motor no conoce (alcance o tipo de descuento nuevo, campos
 * faltantes) da **cero**, no truena: el backend se actualiza antes que las cajas.
 */

export type CouponEngineDiscount =
    | { type: 'percent'; percent: number }
    | { type: 'amount'; amountCents: number };

export interface CouponEngineCoupon {
    scope: 'product' | 'sale';
    productIds: string[];
    discount: CouponEngineDiscount;
    minPurchaseCents: number | null;
}

export interface CouponEngineLine {
    productId: string;
    /** Piezas de la partida (una partida por caja cuenta `cajas × piezas por caja`). */
    pieces: number;
    /** Neto de la partida en centavos, antes del cupón. */
    netCents: number;
    hasPromotion: boolean;
}

export interface CouponEngineResult {
    /** Descuento por partida, en el mismo orden; 0 en las no elegibles. */
    lines: number[];
    /** Descuento a nivel venta (solo alcance `sale`). */
    saleCents: number;
    totalCents: number;
}

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/** Monto de la regla sobre `baseCents`, nunca negativo ni mayor que la base. */
const applyDiscount = (
    discount: CouponEngineDiscount,
    baseCents: number,
    units: number,
): number => {
    if (baseCents <= 0) {
        return 0;
    }
    let cents = 0;
    if (discount.type === 'percent' && isFiniteNumber(discount.percent) && discount.percent > 0) {
        cents = Math.round((baseCents * discount.percent) / 100);
    } else if (discount.type === 'amount' && isFiniteNumber(discount.amountCents) &&
        discount.amountCents > 0) {
        cents = Math.round(discount.amountCents * units);
    }
    return Math.max(0, Math.min(cents, baseCents));
};

export const computeCouponDiscount = (
    coupon: CouponEngineCoupon,
    lines: CouponEngineLine[],
): CouponEngineResult => {
    const zero: CouponEngineResult = {
        lines: lines.map(() => 0),
        saleCents: 0,
        totalCents: 0,
    };
    const discount = coupon?.discount;
    if (!discount || (discount.type !== 'percent' && discount.type !== 'amount')) {
        return zero;
    }

    if (coupon.scope === 'product') {
        const eligible = new Set(Array.isArray(coupon.productIds) ? coupon.productIds : []);
        const perLine = lines.map((line) => (
            eligible.has(line.productId) && !line.hasPromotion
                ? applyDiscount(discount, line.netCents, line.pieces)
                : 0
        ));
        return {
            lines: perLine,
            saleCents: 0,
            totalCents: perLine.reduce((sum, cents) => sum + cents, 0),
        };
    }

    if (coupon.scope === 'sale') {
        const baseCents = lines.reduce((sum, line) => sum + line.netCents, 0);
        if (coupon.minPurchaseCents !== null && coupon.minPurchaseCents !== undefined &&
            baseCents < coupon.minPurchaseCents) {
            return zero;
        }
        const saleCents = applyDiscount(discount, baseCents, 1);
        return { lines: lines.map(() => 0), saleCents, totalCents: saleCents };
    }

    return zero;
};
