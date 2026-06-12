import { Sale } from '../types';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('sales');

export const createSale = async (
    data: Omit<Sale, 'id' | 'createdAt'>,
): Promise<Sale> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const getSaleById = async (id: string): Promise<Sale | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Sale;
};

export const listSales = async (filters: {
    productId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Sale[]; total: number }> => {
    const snapshot = await collection()
        .orderBy('createdAt', 'desc')
        .get();

    let sales = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Sale));

    if (filters.from) {
        const fromMs = new Date(filters.from).getTime();
        sales = sales.filter((sale) => sale.createdAt.toMillis() >= fromMs);
    }

    if (filters.to) {
        const toMs = new Date(filters.to).getTime();
        sales = sales.filter((sale) => sale.createdAt.toMillis() <= toMs);
    }

    if (filters.productId) {
        sales = sales.filter((sale) =>
            sale.items.some((item) => item.productId === filters.productId),
        );
    }

    if (filters.page !== undefined || filters.limit !== undefined) {
        return paginate(sales, filters.page ?? 1, filters.limit ?? 100);
    }

    return { items: sales, total: sales.length };
};
