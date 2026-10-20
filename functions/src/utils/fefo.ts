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

export const allocateFefo = (
    batches: Batch[],
    requestedQuantity: number,
    options: AllocateFefoOptions = {},
): BatchAllocation[] => {
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

    if (remaining > 0) {
        const expiredQty = withStock
            .filter((batch) => isExpired(batch, reference))
            .reduce((sum, batch) => sum + batch.quantity, 0);
        if (excludeExpired && expiredQty > 0) {
            throw new Error('EXPIRED_STOCK');
        }
        throw new Error(`Stock insuficiente. Faltan ${remaining} unidades.`);
    }

    return allocations;
};
