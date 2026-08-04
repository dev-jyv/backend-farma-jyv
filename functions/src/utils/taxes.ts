import { IVA_RATE, IVA_ZERO_RATE } from '../constants/taxes';
import { SaleItemTaxes, SaleTaxSummary } from '../types';

/**
 * Desglose de impuestos para precios **con impuestos incluidos**.
 *
 * Orden legal en México: el IEPS se calcula sobre la base y el IVA sobre
 * (base + IEPS). Entonces, para un importe cobrado `gross`:
 *
 *   gross = base * (1 + iepsRate) * (1 + ivaRate)
 *   base  = gross / ((1 + iepsRate) * (1 + ivaRate))
 *   ieps  = base * iepsRate
 *   iva   = (base + ieps) * ivaRate
 *
 * Todo se redondea a centavos y el residuo de redondeo se absorbe en la base,
 * de modo que `base + ieps + iva === gross` **exactamente**. Un CFDI cuyo
 * desglose no suma el total es rechazado por el PAC, así que este invariante no
 * es cosmético.
 */

export const toCents = (value: number): number => Math.round(value * 100);

export const fromCents = (cents: number): number => cents / 100;

export interface TaxableLineInput {
    /** Importe efectivamente cobrado por la partida, impuestos incluidos. */
    grossAmount: number;
    hasIva: boolean;
    hasIvaZero: boolean;
    hasIeps: boolean;
    iepsRate?: number;
}

/** Tasa de IVA efectiva del producto. `hasIvaZero` gana sobre `hasIva`. */
export const resolveIvaRate = (product: {
    hasIva: boolean;
    hasIvaZero: boolean;
}): number => {
    if (product.hasIvaZero) {
        return IVA_ZERO_RATE;
    }
    return product.hasIva ? IVA_RATE : 0;
};

export const resolveIepsRate = (product: {
    hasIeps: boolean;
    iepsRate?: number;
}): number => (product.hasIeps ? product.iepsRate ?? 0 : 0);

/**
 * Desglosa un importe cobrado con tasas ya conocidas. Se usa en devoluciones:
 * el reembolso debe llevar exactamente las tasas de la venta original, no las
 * del catálogo (que pueden haber cambiado desde entonces).
 */
export const breakdownWithRates = (input: {
    grossAmount: number;
    ivaRate: number;
    iepsRate: number;
}): SaleItemTaxes => {
    const { ivaRate, iepsRate } = input;
    const grossCents = toCents(input.grossAmount);

    const baseCents = Math.round(grossCents / ((1 + iepsRate) * (1 + ivaRate)));
    const iepsCents = Math.round(baseCents * iepsRate);
    const ivaCents = Math.round((baseCents + iepsCents) * ivaRate);

    return {
        base: fromCents(grossCents - iepsCents - ivaCents),
        ivaRate,
        ivaAmount: fromCents(ivaCents),
        iepsRate,
        iepsAmount: fromCents(iepsCents),
    };
};

export const breakdownLineTaxes = (input: TaxableLineInput): SaleItemTaxes => {
    const ivaRate = resolveIvaRate(input);
    const iepsRate = resolveIepsRate(input);
    const grossCents = toCents(input.grossAmount);

    const baseCents = Math.round(grossCents / ((1 + iepsRate) * (1 + ivaRate)));
    const iepsCents = Math.round(baseCents * iepsRate);
    const ivaCents = Math.round((baseCents + iepsCents) * ivaRate);
    // El residuo va a la base para que el desglose sume el importe cobrado.
    const adjustedBaseCents = grossCents - iepsCents - ivaCents;

    return {
        base: fromCents(adjustedBaseCents),
        ivaRate,
        ivaAmount: fromCents(ivaCents),
        iepsRate,
        iepsAmount: fromCents(iepsCents),
    };
};

export const sumTaxSummary = (breakdowns: SaleItemTaxes[]): SaleTaxSummary => {
    let baseCents = 0;
    let ivaCents = 0;
    let iepsCents = 0;

    for (const breakdown of breakdowns) {
        baseCents += toCents(breakdown.base);
        ivaCents += toCents(breakdown.ivaAmount);
        iepsCents += toCents(breakdown.iepsAmount);
    }

    return {
        base: fromCents(baseCents),
        ivaTotal: fromCents(ivaCents),
        iepsTotal: fromCents(iepsCents),
        taxTotal: fromCents(ivaCents + iepsCents),
        total: fromCents(baseCents + ivaCents + iepsCents),
    };
};

/**
 * Reparte un descuento a nivel venta entre las partidas, proporcional al importe
 * de cada una. El descuento debe prorratearse **antes** de calcular impuestos:
 * si no, el IVA se declara sobre un importe que nunca se cobró.
 *
 * Los centavos que no se reparten exacto se cargan a la partida de mayor
 * importe, para que la suma de las partes sea el descuento exacto.
 */
export const prorateDiscount = (
    lineAmounts: number[],
    discountAmount: number,
): number[] => {
    const totalCents = lineAmounts.reduce((sum, amount) => sum + toCents(amount), 0);
    const discountCents = toCents(discountAmount);

    if (discountCents <= 0 || totalCents <= 0) {
        return lineAmounts.map(() => 0);
    }
    if (discountCents >= totalCents) {
        return lineAmounts.map((amount) => amount);
    }

    const shares = lineAmounts.map(
        (amount) => Math.floor((toCents(amount) * discountCents) / totalCents),
    );
    const assigned = shares.reduce((sum, share) => sum + share, 0);
    let remainder = discountCents - assigned;

    // Reparte el residuo de mayor a menor importe, un centavo por partida.
    const order = lineAmounts
        .map((amount, index) => ({ index, cents: toCents(amount) }))
        .sort((a, b) => b.cents - a.cents);

    let cursor = 0;
    while (remainder > 0 && order.length) {
        const { index } = order[cursor % order.length];
        if (shares[index] < toCents(lineAmounts[index])) {
            shares[index] += 1;
            remainder -= 1;
        }
        cursor += 1;
        if (cursor > order.length * 100) {
            break;
        }
    }

    return shares.map(fromCents);
};
