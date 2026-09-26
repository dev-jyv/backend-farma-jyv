import { Promotion, PromotionPerformance, Sale, isSaleProductItem } from '../types';
import { fromCents, toCents } from './taxes';

/**
 * Desempeño de una promoción, **sin Firestore**: recibe las ventas ya leídas y
 * solo agrega. Así se prueba con ventas armadas a mano y el servicio queda en
 * dos consultas.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Tope de la ventana de comparación. Una promo que lleva un año activa no se
 * compara contra el año anterior completo: la estacionalidad (gripa en
 * invierno) pesaría más que la promoción, y la lectura saldría carísima.
 */
export const PERFORMANCE_BASELINE_MAX_DAYS = 90;

const round2 = (value: number): number => Math.round(value * 100) / 100;

type PromotionWindow = Pick<Promotion, 'startsAt' | 'endsAt' | 'deactivatedAt'>;

/**
 * Hasta cuándo contó la promoción: lo primero entre su fin programado, la baja
 * y ahora. Una promo dada de baja antes de tiempo no se mide hasta `endsAt`,
 * o sus ventas por día saldrían diluidas en días en que ya no aplicaba.
 */
export const promotionEffectiveEndMs = (promotion: PromotionWindow, nowMs: number): number =>
    Math.min(
        nowMs,
        promotion.endsAt?.toMillis() ?? Infinity,
        promotion.deactivatedAt?.toMillis() ?? Infinity,
    );

export interface PerformanceWindows {
    startMs: number;
    effectiveEndMs: number;
    /** Días de vigencia, a 2 decimales y mínimo 1 (ver `daysActive`). */
    daysActive: number;
    /** `[baselineFromMs, startMs)`: misma duración, justo antes, tope 90 días. */
    baselineFromMs: number;
    baselineDays: number;
}

/**
 * Mínimo un día: una promo de horas (o que aún no empieza) daría ventas por
 * día infladas o una división entre cero.
 */
export const performanceWindows = (
    promotion: PromotionWindow,
    nowMs: number,
): PerformanceWindows => {
    const startMs = promotion.startsAt.toMillis();
    const effectiveEndMs = promotionEffectiveEndMs(promotion, nowMs);
    const daysActive = Math.max(1, round2((effectiveEndMs - startMs) / MS_PER_DAY));
    const baselineDays = Math.min(daysActive, PERFORMANCE_BASELINE_MAX_DAYS);
    return {
        startMs,
        effectiveEndMs,
        daysActive,
        baselineFromMs: startMs - Math.round(baselineDays * MS_PER_DAY),
        baselineDays,
    };
};

interface ProductAccumulator {
    productId: string;
    productName: string;
    unitsSold: number;
    discountCents: number;
    netCents: number;
}

/**
 * - `promotionSales`: ventas que llevan la promo (`promotionIds array-contains`).
 *   Se cuentan solo las partidas con **esa** promo: la misma venta puede traer
 *   otros productos a precio normal.
 * - `baselineSales`: ventas de la ventana previa que tocan alguno de sus
 *   productos. Se cuentan todas las piezas de esos productos, con o sin otra
 *   promoción: es "cuánto se vendía antes", no "cuánto se vendía sin promo".
 *
 * Las anuladas se descartan aquí, no en la consulta (mismo criterio que el
 * resto de reportes: filtrar `voidedAt` en Firestore pediría otro índice).
 * Las devoluciones parciales **no** se restan: el desempeño mide lo que se
 * cobró con la promo, igual que el top de productos del reporte de ventas.
 */
export const buildPromotionPerformance = (input: {
    promotion: Promotion;
    nowMs: number;
    promotionSales: Sale[];
    baselineSales: Sale[];
}): PromotionPerformance => {
    const { promotion } = input;
    const windows = performanceWindows(promotion, input.nowMs);

    let salesCount = 0;
    let unitsSold = 0;
    let discountCents = 0;
    let netCents = 0;
    let costCents = 0;
    let costComplete = true;
    const byProduct = new Map<string, ProductAccumulator>();

    for (const sale of input.promotionSales) {
        if (sale.voidedAt) {
            continue;
        }
        const items = sale.items
            .filter(isSaleProductItem)
            .filter((item) => item.promotion?.promotionId === promotion.id);
        if (!items.length) {
            continue;
        }
        salesCount += 1;
        for (const item of items) {
            const itemDiscountCents = toCents(item.promotion?.discountAmount ?? 0);
            const itemNetCents = toCents(item.subtotal) - toCents(item.discountAmount);
            unitsSold += item.quantity;
            discountCents += itemDiscountCents;
            netCents += itemNetCents;
            // `null` o ausente es "sin costo", no "costo cero": una sola partida
            // así invalida la utilidad en vez de inflarla.
            if (typeof item.costAmount === 'number') {
                costCents += toCents(item.costAmount);
            } else {
                costComplete = false;
            }

            const entry = byProduct.get(item.productId) ?? {
                productId: item.productId,
                productName: item.productName,
                unitsSold: 0,
                discountCents: 0,
                netCents: 0,
            };
            entry.unitsSold += item.quantity;
            entry.discountCents += itemDiscountCents;
            entry.netCents += itemNetCents;
            byProduct.set(item.productId, entry);
        }
    }

    const promoProducts = new Set(promotion.productIds);
    const baselineToMs = windows.startMs;
    let baselineUnits = 0;
    for (const sale of input.baselineSales) {
        const createdMs = sale.createdAt.toMillis();
        // La consulta ya acota el rango; se revalida para que la función no
        // dependa de que quien la llame haya leído exactamente esa ventana.
        if (sale.voidedAt || createdMs < windows.baselineFromMs || createdMs >= baselineToMs) {
            continue;
        }
        for (const item of sale.items.filter(isSaleProductItem)) {
            if (promoProducts.has(item.productId)) {
                baselineUnits += item.quantity;
            }
        }
    }

    const duringPerDay = unitsSold / windows.daysActive;
    const baselinePerDay = baselineUnits / windows.baselineDays;
    const baselinePerDayRounded = round2(baselinePerDay);

    return {
        promotionId: promotion.id,
        name: promotion.name,
        startsAt: new Date(windows.startMs).toISOString(),
        endsAt: promotion.endsAt ? promotion.endsAt.toDate().toISOString() : null,
        effectiveEnd: new Date(windows.effectiveEndMs).toISOString(),
        daysActive: windows.daysActive,
        salesCount,
        unitsSold,
        discountTotal: fromCents(discountCents),
        netRevenue: fromCents(netCents),
        costTotal: costComplete ? fromCents(costCents) : null,
        grossProfit: costComplete ? fromCents(netCents - costCents) : null,
        unitsPerDayDuring: round2(duringPerDay),
        baseline: {
            days: windows.baselineDays,
            unitsSold: baselineUnits,
            unitsPerDay: baselinePerDayRounded,
        },
        // `null` cuando la base que ve el admin es 0: un "+4,900 %" sobre una
        // pieza vendida en tres meses no dice nada de la promoción. El cociente
        // sí va con los valores sin redondear, para no arrastrar el redondeo.
        liftPercent: baselinePerDayRounded > 0
            ? round2((duringPerDay / baselinePerDay - 1) * 100)
            : null,
        byProduct: [...byProduct.values()]
            .sort((a, b) => b.unitsSold - a.unitsSold || a.productName.localeCompare(b.productName))
            .map((entry) => ({
                productId: entry.productId,
                productName: entry.productName,
                unitsSold: entry.unitsSold,
                discountTotal: fromCents(entry.discountCents),
                netRevenue: fromCents(entry.netCents),
            })),
    };
};
