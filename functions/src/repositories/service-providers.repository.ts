import { ServiceProvider } from '../types';
import { notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('serviceProviders');

const toProvider = (
    doc: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.QueryDocumentSnapshot,
): ServiceProvider => ({ id: doc.id, ...doc.data() } as ServiceProvider);

/** Padrón completo sin paginar (pull local-first del POS); incluye bajas. */
export const listServiceProviders = async (filters: {
    activeOnly?: boolean;
    updatedSince?: string;
} = {}): Promise<ServiceProvider[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.activeOnly) {
        query = query.where('isActive', '==', true);
    }
    if (filters.updatedSince) {
        query = query.where('updatedAt', '>=', toTimestamp(filters.updatedSince));
    }

    const snapshot = await query.get();
    const providers = snapshot.docs.map(toProvider);
    providers.sort((a, b) => a.name.localeCompare(b.name));
    return providers;
};

export const listServiceProvidersPage = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page: number;
    limit: number;
}): Promise<{ items: ServiceProvider[]; total: number }> => {
    // Igual que en proveedores: sin búsqueda pagina Firestore (índice
    // `[isActive, name]`); con búsqueda, memoria.
    if (!filters.search) {
        let query: FirebaseFirestore.Query = collection();
        if (filters.activeOnly) {
            query = query.where('isActive', '==', true);
        }
        return paginateQuery(
            query.orderBy('name', 'asc'),
            toProvider,
            filters.page,
            filters.limit,
        );
    }

    const providers = await listServiceProviders({ activeOnly: filters.activeOnly });
    const term = filters.search.trim().toLowerCase();
    const matches = providers.filter(
        (provider) =>
            provider.name.toLowerCase().includes(term) ||
            (provider.license?.toLowerCase().includes(term) ?? false),
    );

    return paginate(matches, filters.page, filters.limit);
};

export const getServiceProviderById = async (id: string): Promise<ServiceProvider | null> => {
    const doc = await collection().doc(id).get();
    return doc.exists ? toProvider(doc) : null;
};

export const createServiceProvider = async (
    data: Omit<ServiceProvider, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<ServiceProvider> => {
    const timestamp = now();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateServiceProvider = async (
    id: string,
    data: Partial<Omit<ServiceProvider, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<ServiceProvider> => {
    const timestamp = now();
    await collection().doc(id).update({ ...data, updatedAt: timestamp });
    const updated = await getServiceProviderById(id);
    if (!updated) {
        throw notFound('Doctor');
    }
    return updated;
};
