import { InventoryCount } from '../types';
import { db, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('inventoryCounts');

const DEFAULT_LIST_DAYS = 90;

export const mapInventoryCount = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): InventoryCount => ({
    id,
    folio: data.folio as string,
    items: data.items as InventoryCount['items'],
    productIds: (data.productIds as string[] | undefined) ?? [],
    totalDifferenceUnits: data.totalDifferenceUnits as number,
    positiveUnits: data.positiveUnits as number,
    negativeUnits: data.negativeUnits as number,
    notes: (data.notes as string | null) ?? null,
    createdBy: data.createdBy as string,
    createdAt: data.createdAt as InventoryCount['createdAt'],
});

export const getInventoryCountById = async (
    id: string,
): Promise<InventoryCount | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapInventoryCount(doc.id, doc.data()!);
};

export const listInventoryCounts = async (filters: {
    productId?: string;
    from?: string;
    to?: string;
}): Promise<InventoryCount[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.productId) {
        query = query.where('productIds', 'array-contains', filters.productId);
    } else {
        const from = filters.from ??
            new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();
        query = query.where('createdAt', '>=', toTimestamp(from));
        if (filters.to) {
            query = query.where('createdAt', '<=', toTimestamp(filters.to));
        }
    }

    const snapshot = await query.get();
    return snapshot.docs
        .map((doc) => mapInventoryCount(doc.id, doc.data()))
        .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
};
