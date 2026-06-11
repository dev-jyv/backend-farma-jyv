import { StockMovement, StockMovementType } from '../types';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('stockMovements');

export const createStockMovement = async (
    data: Omit<StockMovement, 'id' | 'createdAt'>,
): Promise<StockMovement> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const listStockMovements = async (filters: {
    productId?: string;
    type?: StockMovementType;
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: StockMovement[]; total: number }> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.productId) {
        query = query.where('productId', '==', filters.productId);
    }

    if (filters.type) {
        query = query.where('type', '==', filters.type);
    }

    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    let movements = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as StockMovement),
    );

    if (filters.from) {
        const fromMs = new Date(filters.from).getTime();
        movements = movements.filter((m) => m.createdAt.toMillis() >= fromMs);
    }

    if (filters.to) {
        const toMs = new Date(filters.to).getTime();
        movements = movements.filter((m) => m.createdAt.toMillis() <= toMs);
    }

    if (filters.search) {
        const term = filters.search.toLowerCase();
        movements = movements.filter(
            (movement) =>
                movement.productId.toLowerCase().includes(term) ||
                movement.type.toLowerCase().includes(term) ||
                (movement.reason?.toLowerCase().includes(term) ?? false),
        );
    }

    return paginate(movements, filters.page ?? 1, filters.limit ?? 100);
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
