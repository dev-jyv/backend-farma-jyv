import { Promotion } from '../types';
import { notFound } from '../utils/errors';
import { paginateQuery } from '../utils/firestore-pagination';
import { paginate } from '../utils/pagination';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('promotions');

const toPromotion = (
    doc: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.QueryDocumentSnapshot,
): Promotion => ({ id: doc.id, ...doc.data() } as Promotion);

/**
 * Lectura completa sin paginar, para el pull local-first del POS. Incluye
 * inactivas a propósito: la caja necesita enterarse de las bajas para dejar de
 * aplicarlas.
 */
export const listPromotions = async (filters: {
    activeOnly?: boolean;
    updatedSince?: string;
} = {}): Promise<Promotion[]> => {
    let query: FirebaseFirestore.Query = collection();
    if (filters.activeOnly) {
        query = query.where('isActive', '==', true);
    }
    if (filters.updatedSince) {
        query = query.where('updatedAt', '>=', toTimestamp(filters.updatedSince));
    }
    const snapshot = await query.get();
    const promotions = snapshot.docs.map(toPromotion);
    promotions.sort((a, b) => a.name.localeCompare(b.name));
    return promotions;
};

/**
 * Página del listado del admin. Sin búsqueda la resuelve Firestore (índice
 * `[isActive, name]`); con búsqueda se filtra en memoria, igual que en servicios.
 */
export const listPromotionsPage = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page: number;
    limit: number;
}): Promise<{ items: Promotion[]; total: number }> => {
    if (!filters.search) {
        let query: FirebaseFirestore.Query = collection();
        if (filters.activeOnly) {
            query = query.where('isActive', '==', true);
        }
        return paginateQuery(
            query.orderBy('name', 'asc'),
            toPromotion,
            filters.page,
            filters.limit,
        );
    }

    const promotions = await listPromotions({ activeOnly: filters.activeOnly });
    const term = filters.search.trim().toLowerCase();
    const matches = promotions.filter(
        (promotion) =>
            promotion.name.toLowerCase().includes(term) ||
            (promotion.description?.toLowerCase().includes(term) ?? false),
    );
    return paginate(matches, filters.page, filters.limit);
};

export const getPromotionById = async (id: string): Promise<Promotion | null> => {
    const doc = await collection().doc(id).get();
    return doc.exists ? toPromotion(doc) : null;
};

/**
 * Promociones activas que incluyen el producto. `isActive` se filtra en memoria
 * para no exigir un índice compuesto `[productIds, isActive]`: un producto
 * aparece en pocas promociones.
 */
export const listActivePromotionsForProduct = async (productId: string): Promise<Promotion[]> => {
    const snapshot = await collection().where('productIds', 'array-contains', productId).get();
    return snapshot.docs.map(toPromotion).filter((promotion) => promotion.isActive);
};

/** Una sola ida a Firestore para todas las promociones de una venta. */
export const getPromotionsByIds = async (ids: string[]): Promise<Map<string, Promotion>> => {
    const unique = [...new Set(ids)];
    const result = new Map<string, Promotion>();
    if (!unique.length) {
        return result;
    }
    const docs = await db().getAll(...unique.map((id) => collection().doc(id)));
    for (const doc of docs) {
        if (doc.exists) {
            result.set(doc.id, toPromotion(doc));
        }
    }
    return result;
};

export const createPromotion = async (
    data: Omit<Promotion, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Promotion> => {
    const timestamp = now();
    const ref = collection().doc();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    await ref.create(payload);
    return { id: ref.id, ...payload };
};

type PromotionPatch = Partial<Omit<
    Promotion,
    'id' | 'rule' | 'productIds' | 'deactivatedAt' | 'createdAt' | 'updatedAt'
>>;

/**
 * `deactivatedAt` se decide **aquí dentro**, contra el documento leído en la
 * transacción: si se calculara con una lectura previa, una reactivación y una
 * baja simultáneas podían dejar `isActive: false` con `deactivatedAt: null`, y
 * sin fecha de baja la vigencia nunca cierra. Devuelve el antes y el después
 * para que el servicio audite sin otra lectura.
 */
export const updatePromotion = async (
    id: string,
    data: PromotionPatch,
): Promise<{ before: Promotion; after: Promotion }> =>
    db().runTransaction(async (transaction) => {
        const docRef = collection().doc(id);
        const snapshot = await transaction.get(docRef);
        if (!snapshot.exists) {
            throw notFound('Promoción');
        }
        const before = toPromotion(snapshot);
        const patch: Record<string, unknown> = Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined),
        );
        if (data.isActive === false && before.isActive) {
            patch.deactivatedAt = now();
        } else if (data.isActive === true && !before.isActive) {
            patch.deactivatedAt = null;
        }
        const timestamp = now();
        transaction.update(docRef, { ...patch, updatedAt: timestamp });
        return {
            before,
            after: { ...before, ...patch, updatedAt: timestamp } as Promotion,
        };
    });
