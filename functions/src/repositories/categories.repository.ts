import { Category } from '../types';
import { notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('categories');

export const listCategories = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Category[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 100;

    // Sin búsqueda la página la resuelve Firestore (índice `[isActive, name]`).
    // La rama de búsqueda sigue leyendo y filtrando en memoria a propósito:
    // recortar antes de filtrar perdería coincidencias fuera de la página.
    if (!filters.search) {
        let query: FirebaseFirestore.Query = collection();
        if (filters.activeOnly !== false) {
            query = query.where('isActive', '==', true);
        }
        return paginateQuery(
            query.orderBy('name', 'asc'),
            (doc) => ({ id: doc.id, ...doc.data() } as Category),
            page,
            limit,
        );
    }

    const query = filters.activeOnly !== false
        ? collection().where('isActive', '==', true)
        : collection();
    const snapshot = await query.get();
    let categories = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as Category),
    );

    const term = filters.search.toLowerCase();
    categories = categories.filter(
        (category) =>
            category.name.toLowerCase().includes(term) ||
            (category.description?.toLowerCase().includes(term) ?? false),
    );
    categories.sort((a, b) => a.name.localeCompare(b.name));

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
        throw notFound('Categoría');
    }
    return updated;
};

export const countActiveProductsByCategory = async (categoryId: string): Promise<number> => {
    const snapshot = await db()
        .collection('products')
        .where('categoryId', '==', categoryId)
        .where('isActive', '==', true)
        .limit(1)
        .get();
    return snapshot.size;
};
