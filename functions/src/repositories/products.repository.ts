import { Product } from '../types';
import { conflict } from '../utils/errors';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('products');

const UNIQUE_FIELD_LABELS: Record<'sku' | 'name' | 'barcode', string> = {
    sku: 'SKU',
    name: 'nombre',
    barcode: 'código de barras',
};

const findDuplicate = async (
    transaction: FirebaseFirestore.Transaction,
    field: 'sku' | 'name' | 'barcode',
    value: string,
): Promise<Product | null> => {
    const snapshot = await transaction.get(collection().where(field, '==', value).limit(1));
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Product;
};

// Corre dentro de la misma transacción que la escritura para evitar que dos
// altas/ediciones concurrentes con el mismo sku/nombre/barcode pasen ambas.
const assertNoDuplicate = async (
    transaction: FirebaseFirestore.Transaction,
    data: { sku?: string; name?: string; barcode?: string },
    excludeId?: string,
): Promise<void> => {
    const checks: Array<['sku' | 'name' | 'barcode', string | undefined]> = [
        ['sku', data.sku],
        ['name', data.name],
        ['barcode', data.barcode],
    ];

    for (const [field, value] of checks) {
        if (!value) {
            continue;
        }
        const duplicate = await findDuplicate(transaction, field, value);
        if (duplicate && duplicate.id !== excludeId) {
            throw conflict(`Ya existe un producto con ese ${UNIQUE_FIELD_LABELS[field]}`);
        }
    }
};

export const listProducts = async (filters: {
    categoryId?: string;
    activeOnly?: boolean;
    limit?: number;
}): Promise<Product[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.categoryId) {
        query = query.where('categoryId', '==', filters.categoryId);
    } else if (filters.activeOnly !== false) {
        query = query.where('isActive', '==', true);
    }

    if (filters.limit) {
        query = query.limit(filters.limit);
    }

    const snapshot = await query.get();
    let products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Product));

    if (filters.categoryId && filters.activeOnly !== false) {
        products = products.filter((product) => product.isActive);
    }

    products.sort((a, b) => a.name.localeCompare(b.name));

    return products;
};

export const findProductBySkuOrBarcode = async (term: string): Promise<Product | null> => {
    const normalized = term.trim();
    if (!normalized) {
        return null;
    }

    const skuSnap = await collection().where('sku', '==', normalized).limit(1).get();
    if (!skuSnap.empty) {
        const doc = skuSnap.docs[0];
        return { id: doc.id, ...doc.data() } as Product;
    }

    const barcodeSnap = await collection().where('barcode', '==', normalized).limit(1).get();
    if (!barcodeSnap.empty) {
        const doc = barcodeSnap.docs[0];
        return { id: doc.id, ...doc.data() } as Product;
    }

    return null;
};

export const getProductById = async (id: string): Promise<Product | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Product;
};

export const createProduct = async (
    data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Product> => db().runTransaction(async (transaction) => {
    await assertNoDuplicate(transaction, data);

    const timestamp = now();
    const ref = collection().doc();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    transaction.create(ref, payload);
    return { id: ref.id, ...payload };
});

export const updateProduct = async (
    id: string,
    data: Partial<Omit<Product, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<Product> => db().runTransaction(async (transaction) => {
    await assertNoDuplicate(transaction, data, id);

    const docRef = collection().doc(id);
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
        throw new Error('Producto no encontrado tras actualizar');
    }

    const timestamp = now();
    transaction.update(docRef, { ...data, updatedAt: timestamp });
    return { ...snapshot.data(), ...data, id, updatedAt: timestamp } as Product;
});
