import { StockMovement, StockMovementType } from '../types';
import { db, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('stockMovements');

export const listStockMovements = async (filters: {
    productId?: string;
    type?: StockMovementType;
    from?: string;
    to?: string;
}): Promise<StockMovement[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.productId) {
        query = query.where('productId', '==', filters.productId);
    }

    if (filters.type) {
        query = query.where('type', '==', filters.type);
    }

    if (filters.from) {
        query = query.where('createdAt', '>=', toTimestamp(filters.from));
    }

    if (filters.to) {
        query = query.where('createdAt', '<=', toTimestamp(filters.to));
    }

    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    return snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as StockMovement),
    );
};

export const findEntryReferenceByBatchId = async (
    batchId: string,
): Promise<string | null> => {
    const snapshot = await collection()
        .where('batchId', '==', batchId)
        .where('type', '==', 'entry')
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const movement = snapshot.docs[0].data() as StockMovement;
    return movement.referenceId ?? null;
};
