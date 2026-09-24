import {
    computePromotionDiscount,
    isPromotionMonotonic,
    isPromotionOpenAt,
    pickBestPromotion,
    promotionCostCents,
} from '../src/utils/promotions';
import {
    ALL_PERMISSION_AREAS,
    SYSTEM_ROLE_DEFINITIONS,
    hasPermission,
} from '../src/constants/permissions';
import { PromotionRule } from '../src/types';

/**
 * Tabla de casos del motor. **Se copia tal cual** a los specs del POS y del
 * admin (`shared/utils/promotions.spec.ts`): las tres copias del motor deben
 * dar el mismo centavo o el ticket de la caja no cuadra con lo que registra el
 * servidor.
 */
const PARACETAMOL: PromotionRule = { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] };
const ESCALONADO: PromotionRule = {
    type: 'tiered',
    tiers: [{ quantity: 2, price: 60 }, { quantity: 5, price: 140 }],
};
const DOS_POR_UNO: PromotionRule = { type: 'nxm', buy: 2, pay: 1 };
const TRES_POR_DOS: PromotionRule = { type: 'nxm', buy: 3, pay: 2 };
const DIEZ_POR_CIENTO_DESDE_3: PromotionRule = { type: 'percent', percent: 10, minQty: 3 };

const CASES: Array<[string, PromotionRule, number, number, number]> = [
    // [caso, regla, precio unitario, cantidad, descuento esperado]
    ['paracetamol: 1 pieza no llega al paquete', PARACETAMOL, 35, 1, 0],
    ['paracetamol: 2 por $60', PARACETAMOL, 35, 2, 10],
    ['paracetamol: 3 = 60 + 35', PARACETAMOL, 35, 3, 10],
    ['paracetamol: 4 = 2 paquetes', PARACETAMOL, 35, 4, 20],
    ['escalonado: 5 toma el paquete grande', ESCALONADO, 35, 5, 35],
    ['escalonado: 7 = 140 + 60', ESCALONADO, 35, 7, 45],
    ['2x1 con 3 piezas', DOS_POR_UNO, 20, 3, 20],
    ['3x2 con 6 piezas', TRES_POR_DOS, 12.5, 6, 25],
    ['% debajo del mínimo', DIEZ_POR_CIENTO_DESDE_3, 33.33, 2, 0],
    ['% redondea al centavo', DIEZ_POR_CIENTO_DESDE_3, 33.33, 3, 10],
    ['paquete más caro que sueltas no aplica', PARACETAMOL, 25, 2, 0],
];

describe('utils/promotions', () => {
    it.each(CASES)('%s', (_label, rule, unitPrice, quantity, expected) => {
        expect(computePromotionDiscount(rule, unitPrice, quantity)).toBe(expected);
    });

    it('promotionCostCents es lo que se cobra por k piezas', () => {
        expect(promotionCostCents(PARACETAMOL, 3500, 0)).toBe(0);
        expect(promotionCostCents(PARACETAMOL, 3500, 1)).toBe(3500);
        expect(promotionCostCents(PARACETAMOL, 3500, 2)).toBe(6000);
        expect(promotionCostCents(PARACETAMOL, 3500, 3)).toBe(9500);
    });

    it('isPromotionMonotonic detecta reglas donde llevar más cuesta menos', () => {
        expect(isPromotionMonotonic(PARACETAMOL, 35)).toBe(true);
        expect(isPromotionMonotonic(DOS_POR_UNO, 20)).toBe(true);
        expect(isPromotionMonotonic({ type: 'percent', percent: 25, minQty: 5 }, 100)).toBe(false);
        expect(isPromotionMonotonic({
            type: 'tiered', tiers: [{ quantity: 3, price: 50 }],
        }, 35)).toBe(false);
    });

    /**
     * Una regla que esta versión no sabe calcular (tipo nuevo del backend, campos
     * faltantes) vale como sin descuento, no truena: un error aquí dejaba el
     * producto sin poder venderse en la caja.
     */
    it('reglas desconocidas o incompletas no descuentan ni truenan', () => {
        const raras = [
            { type: 'bundle', items: [] },
            { type: 'tiered' },
            { type: 'tiered', tiers: [] },
            { type: 'tiered', tiers: [{ quantity: 2 }] },
            { type: 'nxm', buy: 'dos', pay: 1 },
            { type: 'percent', percent: 10 },
            null,
        ] as unknown as PromotionRule[];
        for (const rule of raras) {
            expect(computePromotionDiscount(rule, 35, 2)).toBe(0);
        }
        expect(pickBestPromotion(
            [{ id: 'rota', rule: raras[1] }, { id: 'buena', rule: PARACETAMOL }],
            35,
            2,
        )?.promotion.id).toBe('buena');
    });

    it('una cantidad no entera se cobra a precio de lista sin tronar', () => {
        expect(computePromotionDiscount(PARACETAMOL, 35, 2.5)).toBe(0);
    });

    it('pickBestPromotion elige la de mayor descuento y no acumula', () => {
        const best = pickBestPromotion(
            [
                { id: 'a', rule: PARACETAMOL },
                { id: 'b', rule: DOS_POR_UNO },
            ],
            35,
            2,
        );
        expect(best).toEqual({ promotion: { id: 'b', rule: DOS_POR_UNO }, discountAmount: 35 });
        expect(pickBestPromotion([{ id: 'a', rule: PARACETAMOL }], 35, 1)).toBeNull();
    });

    it('isPromotionOpenAt respeta inicio, fin, baja y margen offline', () => {
        const at = (ms: number) => ({ toMillis: () => ms });
        const promo = { startsAt: at(1000), endsAt: at(5000), deactivatedAt: null };
        expect(isPromotionOpenAt(promo, 999)).toBe(false);
        expect(isPromotionOpenAt(promo, 5000)).toBe(true);
        expect(isPromotionOpenAt(promo, 5001)).toBe(false);
        expect(isPromotionOpenAt(promo, 5500, 1000)).toBe(true);
        expect(isPromotionOpenAt({ ...promo, endsAt: null }, 1e12)).toBe(true);
        expect(isPromotionOpenAt({ ...promo, deactivatedAt: at(2000) }, 3000)).toBe(false);
    });
});

describe('área promotions', () => {
    const perms = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS) =>
        SYSTEM_ROLE_DEFINITIONS[slug].permissions;

    it('existe en ALL_PERMISSION_AREAS', () => {
        expect(ALL_PERMISSION_AREAS).toContain('promotions');
    });

    it('gerente escribe; cajero solo lee (para el sync del POS); doctor no la tiene', () => {
        expect(hasPermission(perms('manager'), 'promotions', 'write', 'manager')).toBe(true);
        expect(hasPermission(perms('cashier'), 'promotions', 'read', 'cashier')).toBe(true);
        expect(hasPermission(perms('cashier'), 'promotions', 'write', 'cashier')).toBe(false);
        expect(hasPermission(perms('doctor'), 'promotions', 'read', 'doctor')).toBe(false);
    });
});
