import { PromotionRule } from '../types';
import { fromCents, toCents } from './taxes';

/**
 * Motor de promociones por cantidad. **Todo en centavos**, igual que el desglose
 * de impuestos: un 3x$100 cobrado en flotantes deja residuos que no cuadran con
 * el ticket.
 *
 * Este archivo tiene copia en el POS y en el admin (`shared/utils/promotions.ts`),
 * igual que `taxes.ts`: la caja calcula sin red y el servidor recalcula al
 * registrar. Las tres copias se prueban con la misma tabla de casos
 * (`test/promotions-engine.spec.ts`); si se cambia una, se cambian las tres.
 */

/**
 * Lo que cuestan `quantity` piezas con la regla aplicada, en centavos. Es la
 * base del descuento y también de la devolución: devolver `r` de `q` piezas
 * reembolsa `cost(q) − cost(q − r)`, no el promedio.
 */
/**
 * ¿La regla tiene una forma que este motor sabe calcular? Una promo de un tipo
 * que esta versión no conoce (el backend se actualiza antes que las cajas) o con
 * campos faltantes se trata como **sin descuento**, en vez de tronar: un error
 * aquí dejaba sin poder vender el producto en cada cambio del ticket.
 */
export const isSupportedRule = (rule: unknown): rule is PromotionRule => {
    if (!rule || typeof rule !== 'object') {
        return false;
    }
    const candidate = rule as Record<string, unknown>;
    const isInt = (value: unknown, min: number): boolean =>
        typeof value === 'number' && Number.isInteger(value) && value >= min;
    if (candidate['type'] === 'tiered') {
        const tiers = candidate['tiers'];
        return Array.isArray(tiers) && tiers.length > 0 && tiers.every((tier) =>
            Boolean(tier) && isInt(tier.quantity, 1) &&
            typeof tier.price === 'number' && Number.isFinite(tier.price) && tier.price > 0);
    }
    if (candidate['type'] === 'nxm') {
        return isInt(candidate['buy'], 1) && isInt(candidate['pay'], 0);
    }
    if (candidate['type'] === 'percent') {
        const percent = candidate['percent'];
        return typeof percent === 'number' && Number.isFinite(percent) &&
            isInt(candidate['minQty'], 1);
    }
    return false;
};

export const promotionCostCents = (
    rule: PromotionRule,
    unitCents: number,
    quantity: number,
): number => {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        return quantity > 0 ? Math.round(unitCents * quantity) : 0;
    }
    const listCents = unitCents * quantity;
    if (!isSupportedRule(rule)) {
        return listCents;
    }

    if (rule.type === 'nxm') {
        if (rule.buy <= 0 || rule.pay < 0 || rule.pay >= rule.buy) {
            return listCents;
        }
        const bundles = Math.floor(quantity / rule.buy);
        return bundles * rule.pay * unitCents + (quantity % rule.buy) * unitCents;
    }

    if (rule.type === 'percent') {
        if (quantity < rule.minQty || rule.percent <= 0) {
            return listCents;
        }
        return listCents - Math.round((listCents * rule.percent) / 100);
    }

    // Escalonado: mínimo costo combinando paquetes (mochila no acotada). Con
    // 1=$35 y 2=$60, tres piezas salen 60 + 35 = 95. Un paquete más caro que
    // sus piezas sueltas nunca se elige, así que el descuento no sale negativo.
    const tiers = rule.tiers
        .filter((tier) => tier.quantity > 0)
        .map((tier) => ({ quantity: tier.quantity, cents: toCents(tier.price) }));
    const cost = new Array<number>(quantity + 1);
    cost[0] = 0;
    for (let k = 1; k <= quantity; k += 1) {
        let best = cost[k - 1] + unitCents;
        for (const tier of tiers) {
            if (tier.quantity <= k) {
                const candidate = cost[k - tier.quantity] + tier.cents;
                if (candidate < best) {
                    best = candidate;
                }
            }
        }
        cost[k] = best;
    }
    return Math.min(cost[quantity], listCents);
};

/**
 * ¿Llevar una pieza más nunca cuesta menos? Una regla que no lo cumple (25 %
 * desde 5 piezas a $100: 4 cuestan 400 y 5 cuestan 375; o "3 por $50" a $35 c/u)
 * hace que devolver una pieza **baje** lo que vale lo que el cliente se queda, y
 * el reembolso recalculado saldría negativo. El alta las rechaza.
 */
export const isPromotionMonotonic = (rule: PromotionRule, unitPrice: number): boolean => {
    const unitCents = toCents(unitPrice);
    const horizon = rule.type === 'tiered'
        ? 2 * Math.max(...rule.tiers.map((tier) => tier.quantity))
        : rule.type === 'nxm' ? 2 * rule.buy : rule.minQty + 1;
    let previous = 0;
    for (let k = 1; k <= horizon; k += 1) {
        const cost = promotionCostCents(rule, unitCents, k);
        if (cost < previous) {
            return false;
        }
        previous = cost;
    }
    return true;
};

/** Descuento en pesos que aporta la regla sobre `quantity` piezas a `unitPrice`. */
export const computePromotionDiscount = (
    rule: PromotionRule,
    unitPrice: number,
    quantity: number,
): number => {
    const unitCents = toCents(unitPrice);
    const discount = unitCents * quantity - promotionCostCents(rule, unitCents, quantity);
    return fromCents(Math.max(0, discount));
};

/**
 * La mejor promoción para la partida. **No se acumulan**: una línea lleva una
 * sola promo, la de mayor descuento; en empate gana la primera de la lista.
 */
export const pickBestPromotion = <T extends { rule: PromotionRule }>(
    candidates: T[],
    unitPrice: number,
    quantity: number,
): { promotion: T; discountAmount: number } | null => {
    let best: { promotion: T; discountAmount: number } | null = null;
    for (const promotion of candidates) {
        const discountAmount = computePromotionDiscount(promotion.rule, unitPrice, quantity);
        if (discountAmount > 0 && (!best || discountAmount > best.discountAmount)) {
            best = { promotion, discountAmount };
        }
    }
    return best;
};

/**
 * Margen para ventas sin conexión: `/sales/bulk` no trae la hora local del
 * cobro, así que una venta hecha el último día de la promo puede llegar al
 * servidor días después. Pasado este margen, la promo ya no se acepta.
 */
export const PROMOTION_SYNC_GRACE_MS = 72 * 60 * 60 * 1000;

interface PromotionWindow {
    startsAt: { toMillis(): number };
    endsAt: { toMillis(): number } | null;
    deactivatedAt: { toMillis(): number } | null;
}

/**
 * ¿La promoción se puede aplicar a una venta que llega en `atMs`? El fin de
 * vigencia es el primero entre `endsAt` y `deactivatedAt`, más `graceMs`.
 */
export const isPromotionOpenAt = (
    promotion: PromotionWindow,
    atMs: number,
    graceMs = 0,
): boolean => {
    if (atMs < promotion.startsAt.toMillis()) {
        return false;
    }
    const ends = [promotion.endsAt, promotion.deactivatedAt]
        .filter((value): value is { toMillis(): number } => value !== null)
        .map((value) => value.toMillis());
    if (!ends.length) {
        return true;
    }
    return atMs <= Math.min(...ends) + graceMs;
};
