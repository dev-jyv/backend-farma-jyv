import {
    computePromotionDiscount,
    isPromotionMonotonic,
    pickBestPromotion,
} from '../src/utils/promotions';
import { PromotionRule } from '../src/types';
import cases from './promotions-engine.cases.json';

/**
 * Casos dorados del motor. `promotions-engine.cases.json` es **idéntico** en
 * backend, admin y POS (lo vigila `npm run check:promo-engine`), y cada repo
 * corre su copia del motor contra él: si las tres pasan, las tres cobran el
 * mismo centavo. No se edita aquí; si cambia el motor, se regenera en los tres.
 *
 * Las reglas del JSON incluyen formas inválidas a propósito (`null`, un tipo
 * `bogus`): una caja con motor viejo recibe promos que no conoce y debe
 * tratarlas como sin descuento, no tronar. Por eso se castean sin validar.
 */

type Rule = PromotionRule;
const label = (value: unknown): string => JSON.stringify(value);

describe('motor de promociones — casos dorados', () => {
    it('trae las tres secciones con casos', () => {
        expect(cases.discount.length).toBeGreaterThan(0);
        expect(cases.monotonic.length).toBeGreaterThan(0);
        expect(cases.pickBest.length).toBeGreaterThan(0);
    });

    describe('discount', () => {
        it.each(cases.discount.map((entry) => [label(entry), entry] as const))(
            '%s',
            (_name, entry) => {
                expect(computePromotionDiscount(
                    entry.rule as unknown as Rule,
                    entry.unitPrice,
                    entry.quantity,
                )).toBe(entry.discount);
            },
        );
    });

    describe('monotonic', () => {
        it.each(cases.monotonic.map((entry) => [label(entry), entry] as const))(
            '%s',
            (_name, entry) => {
                expect(isPromotionMonotonic(entry.rule as unknown as Rule, entry.unitPrice))
                    .toBe(entry.monotonic);
            },
        );
    });

    describe('pickBest', () => {
        it.each(cases.pickBest.map((entry) => [label(entry), entry] as const))(
            '%s',
            (_name, entry) => {
                const best = pickBestPromotion(
                    entry.candidates as unknown as Array<{ id: string; rule: Rule }>,
                    entry.unitPrice,
                    entry.quantity,
                );
                expect(best
                    ? { id: best.promotion.id, discountAmount: best.discountAmount }
                    : null).toEqual(entry.expected);
            },
        );
    });
});
