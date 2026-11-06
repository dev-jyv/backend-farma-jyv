import { Batch } from '../types';
import { APP_TIME_ZONE, getZonedYmd } from './timezone';

export interface BatchAllocation {
    batchId: string;
    quantity: number;
}

export interface AllocateFefoOptions {
    excludeExpired?: boolean;
    now?: Date;
}

/**
 * La caducidad se guarda como medianoche UTC del día indicado y el lote sigue
 * vendible todo ese día. "Hoy" es el día de la farmacia: con el reloj del proceso
 * (UTC) un lote que caduca hoy se rechazaba desde las 18:00 hora de México.
 */
const isExpired = (batch: Batch, reference: Date): boolean => {
    const expiryYmd = batch.expiryDate.toDate().toISOString().slice(0, 10);
    return expiryYmd < getZonedYmd(reference.getTime(), APP_TIME_ZONE);
};

/**
 * Reparto FEFO **sin rechazo**: asigna lo vendible que haya y devuelve lo que no
 * alcanzó en `shortfall`. Lo usa la venta offline ya cobrada (SPEC 52), que se
 * registra aunque falte stock: el lote nunca baja de cero y el faltante queda
 * medido. `expiredQuantity` es lo que había con stock pero ya caducado a
 * `options.now`, para distinguir "no hay" de "lo que hay está vencido".
 */
export const allocateFefoAvailable = (
    batches: Batch[],
    requestedQuantity: number,
    options: AllocateFefoOptions = {},
): { allocations: BatchAllocation[]; shortfall: number; expiredQuantity: number } => {
    const excludeExpired = options.excludeExpired ?? true;
    const reference = options.now ?? new Date();

    const withStock = batches.filter((batch) => batch.quantity > 0);
    const sellable = excludeExpired
        ? withStock.filter((batch) => !isExpired(batch, reference))
        : withStock;

    const available = [...sellable].sort(
        (a, b) => a.expiryDate.toMillis() - b.expiryDate.toMillis(),
    );

    let remaining = requestedQuantity;
    const allocations: BatchAllocation[] = [];

    for (const batch of available) {
        if (remaining <= 0) {
            break;
        }

        const taken = Math.min(batch.quantity, remaining);
        allocations.push({ batchId: batch.id, quantity: taken });
        remaining -= taken;
    }

    const expiredQuantity = excludeExpired
        ? withStock
            .filter((batch) => isExpired(batch, reference))
            .reduce((sum, batch) => sum + batch.quantity, 0)
        : 0;
    return { allocations, shortfall: Math.max(0, remaining), expiredQuantity };
};

export const allocateFefo = (
    batches: Batch[],
    requestedQuantity: number,
    options: AllocateFefoOptions = {},
): BatchAllocation[] => {
    const { allocations, shortfall, expiredQuantity } = allocateFefoAvailable(
        batches,
        requestedQuantity,
        options,
    );

    if (shortfall > 0) {
        if (expiredQuantity > 0) {
            throw new Error('EXPIRED_STOCK');
        }
        throw new Error(`Stock insuficiente. Faltan ${shortfall} unidades.`);
    }

    return allocations;
};
