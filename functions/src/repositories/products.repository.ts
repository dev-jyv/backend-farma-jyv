import { Product } from '../types';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('products');

export const listProducts = async (filters: {
    categoryId?: string;
    activeOnly?: boolean;
}): Promise<Product[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.categoryId) {
        query = query.where('categoryId', '==', filters.categoryId);
    } else if (filters.activeOnly !== false) {
        query = query.where('isActive', '==', true);
    }

    const snapshot = await query.get();
    let products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Product));

    if (filters.categoryId && filters.activeOnly !== false) {
        products = products.filter((product) => product.isActive);
    }

    products.sort((a, b) => a.name.localeCompare(b.name));

    return products;
};

export const getProductById = async (id: string): Promise<Product | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Product;
};

export const getProductBySku = async (sku: string): Promise<Product | null> => {
    const snapshot = await collection().where('sku', '==', sku).limit(1).get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Product;
};

export const getProductByName = async (name: string): Promise<Product | null> => {
    const snapshot = await collection().where('name', '==', name).limit(1).get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Product;
};

export const getProductByBarcode = async (barcode: string): Promise<Product | null> => {
    const snapshot = await collection().where('barcode', '==', barcode).limit(1).get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Product;
};

export const createProduct = async (
    data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Product> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateProduct = async (
    id: string,
    data: Partial<Omit<Product, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<Product> => {
    const timestamp = now();
    await collection().doc(id).update({ ...data, updatedAt: timestamp });
    const updated = await getProductById(id);
    if (!updated) {
        throw new Error('Producto no encontrado tras actualizar');
    }
    return updated;
};
