import { Batch } from '../types';

export interface BatchAllocation {
    batchId: string;
    quantity: number;
}

export const allocateFefo = (
    batches: Batch[],
    requestedQuantity: number,
): BatchAllocation[] => {
    const available = batches
        .filter((batch) => batch.quantity > 0)
        .sort((a, b) => a.expiryDate.toMillis() - b.expiryDate.toMillis());

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
        throw new Error(`Stock insuficiente. Faltan ${remaining} unidades.`);
    }

    return allocations;
};
