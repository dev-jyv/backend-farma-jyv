import { Customer } from '../types';
import { notFound } from '../utils/errors';
import { paginateQuery } from '../utils/firestore-pagination';
import { applyNamePrefix, normalizeSearchName } from '../utils/search-name';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('customers');

export const listCustomers = async (filters: {
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Customer[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    // Con término: rango por prefijo sobre `searchName` (índice simple). Sin
    // término: listado por nombre, resuelto en Firestore.
    const query =
        applyNamePrefix(collection(), filters.search) ??
        collection().orderBy('name', 'asc');
    return paginateQuery(
        query,
        (doc) => ({ id: doc.id, ...doc.data() } as Customer),
        page,
        limit,
    );
};

export const getCustomerById = async (id: string): Promise<Customer | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Customer;
};

export const createCustomer = async (
    data: Pick<Customer, 'name' | 'rfc' | 'phone' | 'email'>,
): Promise<Customer> => {
    const timestamp = now();
    const payload = {
        ...data,
        searchName: normalizeSearchName(data.name),
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateCustomer = async (
    id: string,
    data: Partial<Pick<Customer, 'name' | 'rfc' | 'phone' | 'email'>>,
): Promise<Customer> => {
    const timestamp = now();
    await collection()
        .doc(id)
        .update({
            ...data,
            ...(data.name !== undefined
                ? { searchName: normalizeSearchName(data.name) }
                : {}),
            updatedAt: timestamp,
        });
    const updated = await getCustomerById(id);
    if (!updated) {
        throw notFound('Cliente');
    }
    return updated;
};
