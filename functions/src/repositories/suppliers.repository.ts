import { Supplier } from '../types';
import { notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('suppliers');

export const listSuppliers = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Supplier[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 100;

    // Igual que en categorías: sin búsqueda pagina Firestore
    // (índice `[isActive, name]`); con búsqueda, memoria.
    if (!filters.search) {
        let query: FirebaseFirestore.Query = collection();
        if (filters.activeOnly) {
            query = query.where('isActive', '==', true);
        }
        return paginateQuery(
            query.orderBy('name', 'asc'),
            (doc) => ({ id: doc.id, ...doc.data() } as Supplier),
            page,
            limit,
        );
    }

    const query = filters.activeOnly
        ? collection().where('isActive', '==', true)
        : collection();
    const snapshot = await query.get();
    let suppliers = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as Supplier),
    );

    const term = filters.search.toLowerCase();
    suppliers = suppliers.filter(
        (supplier) =>
            supplier.name.toLowerCase().includes(term) ||
            (supplier.contactName?.toLowerCase().includes(term) ?? false) ||
            (supplier.email?.toLowerCase().includes(term) ?? false) ||
            (supplier.phone?.toLowerCase().includes(term) ?? false),
    );
    suppliers.sort((a, b) => a.name.localeCompare(b.name));

    return paginate(suppliers, page, limit);
};

export const getSupplierById = async (id: string): Promise<Supplier | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Supplier;
};

export const getSuppliersByIds = async (ids: string[]): Promise<Map<string, Supplier>> => {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) {
        return new Map();
    }

    const refs = uniqueIds.map((id) => collection().doc(id));
    const docs = await db().getAll(...refs);
    const suppliers = new Map<string, Supplier>();

    for (const doc of docs) {
        if (doc.exists) {
            suppliers.set(doc.id, { id: doc.id, ...doc.data() } as Supplier);
        }
    }

    return suppliers;
};

export const createSupplier = async (
    data: Pick<
        Supplier,
        'name' | 'contactName' | 'email' | 'phone' | 'address' | 'notes' | 'isActive'
    >,
): Promise<Supplier> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateSupplier = async (
    id: string,
    data: Partial<
        Pick<
            Supplier,
            'name' | 'contactName' | 'email' | 'phone' | 'address' | 'notes' | 'isActive'
        >
    >,
): Promise<Supplier> => {
    const timestamp = now();
    await collection().doc(id).update({ ...data, updatedAt: timestamp });
    const updated = await getSupplierById(id);
    if (!updated) {
        throw notFound('Proveedor');
    }
    return updated;
};

export const countInvoicesBySupplier = async (supplierId: string): Promise<number> => {
    const snapshot = await db()
        .collection('invoices')
        .where('supplierId', '==', supplierId)
        .limit(1)
        .get();
    return snapshot.size;
};

export const countActiveProductsBySupplier = async (supplierId: string): Promise<number> => {
    const snapshot = await db()
        .collection('products')
        .where('suppliers', 'array-contains', supplierId)
        .where('isActive', '==', true)
        .limit(1)
        .get();
    return snapshot.size;
};
