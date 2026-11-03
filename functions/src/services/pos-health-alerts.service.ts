import { PosBlockedSale } from '../types';

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
