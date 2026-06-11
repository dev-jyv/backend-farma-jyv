import { Category } from '../types';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('categories');

export const listCategories = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Category[]; total: number }> => {
    const query = filters.activeOnly !== false
        ? collection().where('isActive', '==', true)
        : collection();
    const snapshot = await query.get();
    let categories = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as Category),
    );

    if (filters.search) {
        const term = filters.search.toLowerCase();
        categories = categories.filter(
            (category) =>
                category.name.toLowerCase().includes(term) ||
                (category.description?.toLowerCase().includes(term) ?? false),
        );
    }

    categories.sort((a, b) => a.name.localeCompare(b.name));

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 100;
    return paginate(categories, page, limit);
};

export const getCategoryById = async (id: string): Promise<Category | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Category;
};

export const getCategoriesByIds = async (ids: string[]): Promise<Map<string, Category>> => {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) {
        return new Map();
    }

    const refs = uniqueIds.map((id) => collection().doc(id));
    const docs = await db().getAll(...refs);
    const categories = new Map<string, Category>();

    for (const doc of docs) {
        if (doc.exists) {
            categories.set(doc.id, { id: doc.id, ...doc.data() } as Category);
        }
    }

    return categories;
};

export const createCategory = async (
    data: Pick<Category, 'name' | 'description' | 'isActive'>,
): Promise<Category> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateCategory = async (
    id: string,
    data: Partial<Pick<Category, 'name' | 'description' | 'isActive'>>,
): Promise<Category> => {
    const timestamp = now();
    await collection().doc(id).update({ ...data, updatedAt: timestamp });
    const updated = await getCategoryById(id);
    if (!updated) {
        throw new Error('Categoría no encontrada tras actualizar');
    }
    return updated;
};
