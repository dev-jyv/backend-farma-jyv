import { InventoryEntry } from '../types';
import { db } from '../utils/firestore';

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

    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    let entries = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as InventoryEntry),
    );

    if (filters.invoiceId) {
        entries = entries.filter((entry) => entry.invoiceId === filters.invoiceId);
    }

    if (filters.productId) {
        entries = entries.filter((entry) =>
            entry.items.some((item) => item.productId === filters.productId),
        );
    }

    if (filters.from) {
        const fromMs = new Date(filters.from).getTime();
        entries = entries.filter((entry) => entry.createdAt.toMillis() >= fromMs);
    }

    if (filters.to) {
        const toMs = new Date(filters.to).getTime();
        entries = entries.filter((entry) => entry.createdAt.toMillis() <= toMs);
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
