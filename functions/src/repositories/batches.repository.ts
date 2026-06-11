import { Batch } from '../types';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('batches');

export const listBatchesByProduct = async (productId: string): Promise<Batch[]> => {
    const snapshot = await collection()
        .where('productId', '==', productId)
        .orderBy('expiryDate', 'asc')
        .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Batch));
};

export const getBatchById = async (id: string): Promise<Batch | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Batch;
};

export const findBatchByProductLotAndExpiry = async (
    productId: string,
    lotNumber: string,
    expiryDate: string,
): Promise<Batch | null> => {
    const snapshot = await collection()
        .where('productId', '==', productId)
        .where('lotNumber', '==', lotNumber)
        .where('expiryDate', '==', toTimestamp(expiryDate))
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Batch;
};

export const getTotalStock = async (productId: string): Promise<number> => {
    const batches = await listBatchesByProduct(productId);
    return batches.reduce((total, batch) => total + batch.quantity, 0);
};

export const createBatch = async (
    data: Omit<Batch, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Batch> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const buildBatchPayload = (
    productId: string,
    lotNumber: string,
    expiryDate: string,
    quantity: number,
    costPrice?: number,
) => ({
    productId,
    lotNumber,
    expiryDate: toTimestamp(expiryDate),
    quantity,
    costPrice,
});
