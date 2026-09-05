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

/**
 * Lotes con existencia (`quantity > 0`), para alertas de caducidad y conteo
 * físico. La colección `batches` es del orden de miles de documentos en una
 * farmacia; si crece, esto se pagina por `expiryDate`.
 */
export const listBatchesWithStock = async (): Promise<Batch[]> => {
    const snapshot = await collection()
        .where('quantity', '>', 0)
        .orderBy('quantity')
        .get();
    return snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() } as Batch))
        .sort((a, b) => a.expiryDate.toMillis() - b.expiryDate.toMillis());
};

/**
 * Lotes de varios productos en una sola pasada, para el pull del catálogo local
 * del POS (`GET /products/sync`). Firestore limita `in` a 30 valores, así que se
 * consulta por bloques: N/30 consultas en vez de una por producto (N+1). Solo
 * lotes con existencia — el SQLite local los usa para FEFO y caducidad, y un
 * lote en cero no se puede vender.
 */
export const listBatchesWithStockByProductIds = async (
    productIds: string[],
): Promise<Map<string, Batch[]>> => {
    const grouped = new Map<string, Batch[]>();
    if (productIds.length === 0) {
        return grouped;
    }

    const CHUNK_SIZE = 30;
    const chunks: string[][] = [];
    for (let index = 0; index < productIds.length; index += CHUNK_SIZE) {
        chunks.push(productIds.slice(index, index + CHUNK_SIZE));
    }

    const snapshots = await Promise.all(
        chunks.map((chunk) =>
            collection()
                .where('productId', 'in', chunk)
                .where('quantity', '>', 0)
                .get(),
        ),
    );

    for (const snapshot of snapshots) {
        for (const doc of snapshot.docs) {
            const batch = { id: doc.id, ...doc.data() } as Batch;
            const current = grouped.get(batch.productId);
            if (current) {
                current.push(batch);
            } else {
                grouped.set(batch.productId, [batch]);
            }
        }
    }

    // FEFO: el lote que caduca primero se vende primero.
    for (const batches of grouped.values()) {
        batches.sort((a, b) => a.expiryDate.toMillis() - b.expiryDate.toMillis());
    }

    return grouped;
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
