import { FieldValue } from 'firebase-admin/firestore';
import { InventoryCount, InventoryCountItem } from '../types';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { db, now } from '../utils/firestore';
import * as countsRepo from '../repositories/inventory-counts.repository';
import { writeAuditInTransaction } from './audit.service';

const COUNTS_COUNTER_ID = 'inventoryCounts';
const MAX_COUNT_ITEMS = 500;

const buildFolio = (sequence: number): string => `C-${String(sequence).padStart(6, '0')}`;

/**
 * Ajustar inventario sin venta detrás es la vía natural para tapar un robo, así
 * que se limita a administrador y gerente (igual que las devoluciones).
 */
export const assertCanAdjustInventory = (roleSlug: string): void => {
    if (roleSlug !== 'admin' && roleSlug !== 'manager') {
        throw forbidden('Solo un administrador o gerente puede ajustar inventario por conteo');
    }
};

export interface InventoryCountItemInput {
    batchId: string;
    countedQuantity: number;
}

/**
 * Registra un conteo físico y ajusta los lotes contados a la cantidad real.
 *
 * El movimiento generado es `adjustment_count` con cantidad **con signo**, no una
 * merma: una diferencia de conteo y un producto tirado a la basura son cosas
 * distintas y mezclarlas arruina el reporte de mermas.
 */
export const recordInventoryCount = async (input: {
    items: InventoryCountItemInput[];
    notes?: string;
    userId: string;
    roleSlug: string;
}): Promise<InventoryCount> => {
    assertCanAdjustInventory(input.roleSlug);

    if (!input.items.length) {
        throw badRequest('El conteo debe incluir al menos un lote');
    }
    if (input.items.length > MAX_COUNT_ITEMS) {
        throw badRequest(`El conteo no puede incluir más de ${MAX_COUNT_ITEMS} lotes`);
    }

    const seen = new Set<string>();
    for (const item of input.items) {
        if (seen.has(item.batchId)) {
            throw badRequest(`El lote ${item.batchId} aparece dos veces en el conteo`);
        }
        seen.add(item.batchId);
        if (!Number.isInteger(item.countedQuantity) || item.countedQuantity < 0) {
            throw badRequest('La cantidad contada debe ser un entero mayor o igual a cero');
        }
    }

    const firestore = db();
    const countRef = firestore.collection('inventoryCounts').doc();
    const counterRef = firestore.collection('counters').doc(COUNTS_COUNTER_ID);
    const timestamp = now();

    return firestore.runTransaction(async (transaction) => {
        // Lecturas primero: lotes contados, sus productos y el contador de folio.
        const batchDocs = await Promise.all(
            input.items.map((item) =>
                transaction.get(firestore.collection('batches').doc(item.batchId))),
        );

        const productIds = [
            ...new Set(batchDocs.map((doc) => doc.data()?.productId as string | undefined)
                .filter((id): id is string => Boolean(id))),
        ];
        const [counterDoc, ...productDocs] = await Promise.all([
            transaction.get(counterRef),
            ...productIds.map((productId) =>
                transaction.get(firestore.collection('products').doc(productId))),
        ]);

        const productNameById = new Map<string, string>();
        productIds.forEach((productId, index) => {
            const doc = productDocs[index];
            if (!doc.exists) {
                throw notFound(`Producto ${productId}`);
            }
            productNameById.set(productId, doc.data()!.name as string);
        });

        const items: InventoryCountItem[] = [];
        const deltaByProduct = new Map<string, number>();

        input.items.forEach((requested, index) => {
            const batchDoc = batchDocs[index];
            if (!batchDoc.exists) {
                throw notFound(`Lote ${requested.batchId}`);
            }
            const batchData = batchDoc.data()!;
            const expectedQuantity = batchData.quantity as number;
            const difference = requested.countedQuantity - expectedQuantity;
            const productId = batchData.productId as string;

            items.push({
                batchId: requested.batchId,
                productId,
                productName: productNameById.get(productId) ?? '',
                lotNumber: batchData.lotNumber as string,
                expectedQuantity,
                countedQuantity: requested.countedQuantity,
                difference,
            });

            if (difference === 0) {
                // Lote cuadrado: queda en el acta del conteo, pero no genera ajuste.
                return;
            }

            transaction.update(batchDoc.ref, {
                quantity: requested.countedQuantity,
                updatedAt: timestamp,
            });
            transaction.set(firestore.collection('stockMovements').doc(), {
                type: 'adjustment_count',
                productId,
                batchId: requested.batchId,
                quantity: difference,
                reason: input.notes?.trim() || 'Ajuste por conteo físico',
                referenceId: countRef.id,
                userId: input.userId,
                createdAt: timestamp,
            });
            deltaByProduct.set(productId, (deltaByProduct.get(productId) ?? 0) + difference);
        });

        for (const [productId, delta] of deltaByProduct) {
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: FieldValue.increment(delta),
                updatedAt: timestamp,
            });
        }

        const nextSequence = (counterDoc.data()?.value as number | undefined ?? 0) + 1;
        const folio = buildFolio(nextSequence);
        transaction.set(counterRef, { value: nextSequence }, { merge: true });

        const positiveUnits = items
            .filter((item) => item.difference > 0)
            .reduce((total, item) => total + item.difference, 0);
        const negativeUnits = items
            .filter((item) => item.difference < 0)
            .reduce((total, item) => total - item.difference, 0);

        const countData = {
            folio,
            items,
            productIds,
            totalDifferenceUnits: positiveUnits + negativeUnits,
            positiveUnits,
            negativeUnits,
            notes: input.notes?.trim() || null,
            createdBy: input.userId,
            createdAt: timestamp,
        };

        transaction.set(countRef, countData);

        // La bitácora va dentro de la transacción: un ajuste sin rastro es
        // exactamente lo que se quiere evitar.
        if (positiveUnits || negativeUnits) {
            writeAuditInTransaction(transaction, {
                action: 'inventory.count_adjusted',
                entity: 'inventoryCount',
                entityId: countRef.id,
                summary: `Conteo ${folio}: ${items.length} lotes, ` +
                    `+${positiveUnits} / -${negativeUnits} unidades`,
                userId: input.userId,
                roleSlug: input.roleSlug,
                metadata: {
                    folio,
                    adjustedBatches: items.filter((item) => item.difference !== 0).length,
                    positiveUnits,
                    negativeUnits,
                },
            });
        }

        return { id: countRef.id, ...countData };
    });
};

export const getInventoryCount = async (id: string): Promise<InventoryCount> => {
    const count = await countsRepo.getInventoryCountById(id);
    if (!count) {
        throw notFound('Conteo de inventario');
    }
    return count;
};

export const listInventoryCounts = async (filters: {
    productId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: InventoryCount[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const counts = await countsRepo.listInventoryCounts(filters);
    const paginated = paginate(counts, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};
