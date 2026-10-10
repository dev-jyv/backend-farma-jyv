import { Customer } from '../types';
import { notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('customers');

export const listCustomers = async (filters: {
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Customer[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const snapshot = await collection().orderBy('name', 'asc').get();
    let customers = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as Customer),
    );

    if (filters.search) {
        const term = filters.search.toLowerCase();
        customers = customers.filter(
            (customer) =>
                customer.name.toLowerCase().includes(term) ||
                (customer.rfc?.toLowerCase().includes(term) ?? false) ||
                (customer.phone?.toLowerCase().includes(term) ?? false) ||
                (customer.email?.toLowerCase().includes(term) ?? false),
        );
    }

    return paginate(customers, page, limit);
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
    await collection().doc(id).update({ ...data, updatedAt: timestamp });
    const updated = await getCustomerById(id);
    if (!updated) {
        throw notFound('Cliente');
    }
    return updated;
};
