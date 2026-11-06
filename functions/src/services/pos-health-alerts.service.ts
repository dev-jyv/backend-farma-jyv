import {
    PosBlockedSale,
    PosStockDivergence,
    PosStockDrift,
    PosStockSampleItem,
} from '../types';
import { APP_TIME_ZONE, addDaysYmd, getZonedYmd } from '../utils/timezone';

/**
 * Reglas de alerta de la salud de cajas (SPEC 44). Funciones puras: deciden,
 * no mandan nada. El envío vive en `pos-health-alerts-sender.service.ts`, que
 * carga la cadena de correo y por eso solo se importa con `await import()`.
 *
 * `evaluateBlockedSalesAlert` la llama `reportDiagnostics` con el snapshot
 * previo (leído antes de sobrescribirlo) y el reporte nuevo.
 *
 * Regla: alertar solo cuando el problema **aparece** (antes cero ventas
 * bloqueadas, ahora alguna) o **crece** (más que antes). Una caja que sigue
 * igual de atorada no vuelve a alertar en cada reporte cada pocos minutos —eso
 * es justo lo que hace que una alerta se deje de leer.
 */

export type BlockedSalesAlertReason = 'appeared' | 'increased';

export interface BlockedSalesAlertDecision {
    shouldAlert: boolean;
    reason: BlockedSalesAlertReason | null;
    previousCount: number;
    currentCount: number;
    /** Ventas bloqueadas que no estaban en el reporte anterior (por `localId`). */
    newlyBlockedSaleIds: string[];
}

export const evaluateBlockedSalesAlert = (
    previous: { blockedSales: Pick<PosBlockedSale, 'localId'>[] } | null,
    current: { blockedSales: Pick<PosBlockedSale, 'localId'>[] },
): BlockedSalesAlertDecision => {
    const previousSales = previous?.blockedSales ?? [];
    const previousCount = previousSales.length;
    const currentCount = current.blockedSales.length;

    const previousIds = new Set(previousSales.map((sale) => sale.localId));
    const newlyBlockedSaleIds = current.blockedSales
        .map((sale) => sale.localId)
        .filter((localId) => !previousIds.has(localId));

    let reason: BlockedSalesAlertReason | null = null;
    if (currentCount > 0 && previousCount === 0) {
        reason = 'appeared';
    } else if (currentCount > previousCount) {
        reason = 'increased';
    }

    return {
        shouldAlert: reason !== null,
        reason,
        previousCount,
        currentCount,
        newlyBlockedSaleIds,
    };
};

/**
 * Horas sin reportar a partir de las cuales una caja con turno abierto se
 * considera caída. Es el mismo umbral con el que el panel pinta la fila en rojo
 * (SPEC 36): el correo y la tarjeta tienen que contar la misma historia.
 */
export const POS_SILENCE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export interface SilenceAlertInput {
    receivedAt: Date;
    /** `undefined`: POS anterior a SPEC 44 que no informa su turno. */
    openCashSessionId: string | null | undefined;
    silenceAlertedAt: Date | null;
}

/**
 * Una caja amerita aviso de silencio cuando:
 *
 * - informó un turno abierto en su último reporte (una caja apagada fuera de
 *   horario, sin turno, no es noticia; una sin el campo —POS sin actualizar—
 *   tampoco, porque no sabemos si tenía turno);
 * - lleva más del umbral sin reportar (estrictamente más: exactamente 2 h aún
 *   no es rojo en el panel);
 * - no se le avisó ya desde ese reporte: el aviso se marca y solo un reporte
 *   nuevo lo limpia, así que una caja sin red todo el día manda un solo correo.
 */
export const shouldAlertSilence = (
    snapshot: SilenceAlertInput,
    nowMs: number,
    thresholdMs = POS_SILENCE_THRESHOLD_MS,
): boolean => {
    if (typeof snapshot.openCashSessionId !== 'string' || snapshot.openCashSessionId === '') {
        return false;
    }
    if (snapshot.silenceAlertedAt) {
        return false;
    }
    return nowMs - snapshot.receivedAt.getTime() > thresholdMs;
};

/** Tope de productos divergentes guardados en el snapshot (SPEC 67). */
export const MAX_STOCK_DIVERGING = 50;

/**
 * Un `productId` que no puede ser id de documento (vacío, con `/`, `.`/`..` o
 * `__x__`) se descarta en vez de rechazar el diagnóstico entero: `doc()` lo
 * tomaría como ruta y el reporte de la caja se perdería por un dato.
 */
export const isComparableProductId = (id: string): boolean =>
    id.trim() !== '' && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);

/**
 * Ids de la muestra que sí se comparan: válidos y sin repetir (gana el primero,
 * que es el que la caja puso más arriba).
 */
export const comparableSample = (sample: PosStockSampleItem[]): PosStockSampleItem[] => {
    const seen = new Set<string>();
    return sample.filter((item) => {
        if (!isComparableProductId(item.productId) || seen.has(item.productId)) {
            return false;
        }
        seen.add(item.productId);
        return true;
    });
};

/**
 * Compara la muestra de la caja contra `products.totalStock` (SPEC 67). Un
 * producto que ya no existe en el servidor diverge con `server: null`. Se
 * guardan hasta 50 divergentes, en el orden de la muestra (los más vendidos).
 */
export const compareStockSample = (
    sample: PosStockSampleItem[],
    server: ReadonlyMap<string, { name: string; totalStock: number }>,
    checkedAt: Date,
): PosStockDrift => {
    const items = comparableSample(sample);
    const diverging: PosStockDivergence[] = [];
    for (const item of items) {
        const stored = server.get(item.productId);
        if (stored && stored.totalStock === item.localStock) {
            continue;
        }
        diverging.push({
            productId: item.productId,
            name: stored?.name ?? null,
            local: item.localStock,
            server: stored ? stored.totalStock : null,
        });
    }
    return {
        checkedAt: checkedAt.toISOString(),
        compared: items.length,
        diverging: diverging.slice(0, MAX_STOCK_DIVERGING),
    };
};

/** Día local (`YYYY-MM-DD`) de un `checkedAt`; `null` si no se puede leer. */
const driftDay = (drift: PosStockDrift | null | undefined): string | null => {
    const ms = drift ? Date.parse(drift.checkedAt) : NaN;
    return Number.isFinite(ms) ? getZonedYmd(ms, APP_TIME_ZONE) : null;
};

/**
 * ¿Ya se comparó hoy? La caja manda la muestra una vez al día, pero un reinicio
 * después de las 07:00 la volvería a mandar: con esto la comparación cuesta como
 * máximo una muestra (≤ 300 lecturas) por caja al día, y la de la mañana queda.
 */
export const isStockDriftFromToday = (
    drift: PosStockDrift | null | undefined,
    nowDate: Date,
): boolean => driftDay(drift) === getZonedYmd(nowDate.getTime(), APP_TIME_ZONE);

/**
 * Divergencias que se repiten **dos días seguidos** en el mismo producto
 * (SPEC 67): la comparación de hoy contra la de ayer (día calendario local). Una
 * diferencia de un solo día no alerta —puede ser una venta en vuelo—, y como se
 * compara a lo más una vez al día, tampoco se avisa dos veces el mismo día.
 * Devuelve las de hoy, con sus cifras de hoy.
 */
export const repeatedStockDivergences = (
    previous: PosStockDrift | null | undefined,
    current: PosStockDrift,
): PosStockDivergence[] => {
    const previousDay = driftDay(previous);
    const currentDay = driftDay(current);
    if (!previous || !previousDay || !currentDay || previousDay !== addDaysYmd(currentDay, -1)) {
        return [];
    }
    const yesterday = new Set(previous.diverging.map((item) => item.productId));
    return current.diverging.filter((item) => yesterday.has(item.productId));
};
