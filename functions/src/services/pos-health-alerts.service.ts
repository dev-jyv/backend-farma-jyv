import { PosBlockedSale } from '../types';

/**
 * Decide si un diagnóstico de caja amerita alerta comparándolo con el anterior
 * del mismo equipo. **Todavía no se llama desde ningún lado** y no manda nada:
 * queda listo para conectarlo a un correo o push sin rehacer la regla.
 *
 * No va en `reportDiagnostics` a propósito: allí el reporte es una escritura +
 * una consulta, y comparar exige leer el snapshot previo antes de
 * sobrescribirlo. Al conectarlo, leer el previo en el mismo paso (p. ej.
 * `getDiagnostics` antes del `set`) y mandar la alerta fuera del camino de la
 * respuesta a la caja, con el error tragado como `recordAudit`: una alerta que
 * falla no debe tumbar el reporte.
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
