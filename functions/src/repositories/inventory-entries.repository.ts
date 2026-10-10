import { InventoryEntry } from '../types';
import { db, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('inventoryEntries');

export const listInventoryEntries = async (filters: {
    supplierId?: string;
    invoiceId?: string;
    productId?: string;
    from?: string;
    to?: string;
}): Promise<InventoryEntry[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.supplierId) {
        query = query.where('supplierId', '==', filters.supplierId);
    }

    if (filters.invoiceId) {
        query = query.where('invoiceId', '==', filters.invoiceId);
    }

    if (filters.from) {
        query = query.where('createdAt', '>=', toTimestamp(filters.from));
    }

    if (filters.to) {
        query = query.where('createdAt', '<=', toTimestamp(filters.to));
    }

    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    let entries = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as InventoryEntry),
    );

    if (filters.productId) {
        entries = entries.filter((entry) =>
            entry.productIds?.includes(filters.productId!) ||
            entry.items.some((item) => item.productId === filters.productId),
        );
    }

    return entries;
};

export const getInventoryEntryById = async (id: string): Promise<InventoryEntry | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as InventoryEntry;
};
