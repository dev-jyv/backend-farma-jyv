import { Coupon } from '../types';
import { conflict, notFound } from '../utils/errors';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now, toTimestamp } from '../utils/firestore';

/** Colección `coupons`: el id del documento es el código normalizado (SPEC 47). */
export const couponsCollection = () => db().collection('coupons');

export const toCoupon = (
    doc: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.QueryDocumentSnapshot,
): Coupon => ({ id: doc.id, ...doc.data() } as Coupon);

/**
 * Página del panel, más recientes primero. Con `isActive` la consulta usa el
 * índice `coupons [isActive, createdAt DESC]`.
 */
export const listCouponsPage = async (filters: {
    isActive?: boolean;
    page: number;
    limit: number;
}): Promise<{ items: Coupon[]; total: number }> => {
    let query: FirebaseFirestore.Query = couponsCollection();
    if (filters.isActive !== undefined) {
        query = query.where('isActive', '==', filters.isActive);
    }
    return paginateQuery(query.orderBy('createdAt', 'desc'), toCoupon, filters.page, filters.limit);
};

/**
 * Lectura completa sin paginar, para el pull del POS. Incluye inactivos a
 * propósito: la caja tiene que enterarse de las bajas para dejar de aplicarlos,
 * y de `usedCount` para avisar que un cupón parece agotado.
 */
export const listCouponsForSync = async (updatedSince?: string): Promise<Coupon[]> => {
    let query: FirebaseFirestore.Query = couponsCollection();
    if (updatedSince) {
        query = query.where('updatedAt', '>=', toTimestamp(updatedSince));
    }
    const snapshot = await query.get();
    return snapshot.docs.map(toCoupon).sort((a, b) => a.code.localeCompare(b.code));
};

export const getCouponByCode = async (code: string): Promise<Coupon | null> => {
    const doc = await couponsCollection().doc(code).get();
    return doc.exists ? toCoupon(doc) : null;
};

/**
 * Alta con el código como id. La existencia se decide **dentro** de la
 * transacción y la escritura es `create`: dos altas simultáneas del mismo
 * código no pueden pasar las dos, y un código dado de baja no se recicla.
 */
export const createCoupon = async (
    data: Omit<Coupon, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Coupon> => db().runTransaction(async (transaction) => {
    const ref = couponsCollection().doc(data.code);
    const existing = await transaction.get(ref);
    if (existing.exists) {
        throw conflict('Ya existe un cupón con ese código');
    }
    const timestamp = now();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    transaction.create(ref, payload);
    return { id: ref.id, ...payload };
});

/**
 * Baja lógica. `deactivatedAt` se decide contra el documento leído en la
 * transacción (fija el fin de vigencia para las ventas offline). Devuelve si
 * hubo cambio para que el servicio audite solo una baja real.
 */
export const deactivateCoupon = async (
    code: string,
    updatedBy: string,
): Promise<{ coupon: Coupon; changed: boolean }> =>
    db().runTransaction(async (transaction) => {
        const ref = couponsCollection().doc(code);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
            throw notFound('Cupón');
        }
        const before = toCoupon(snapshot);
        if (!before.isActive) {
            return { coupon: before, changed: false };
        }
        const timestamp = now();
        const patch = {
            isActive: false,
            deactivatedAt: timestamp,
            updatedBy,
            updatedAt: timestamp,
        };
        transaction.update(ref, patch);
        return { coupon: { ...before, ...patch }, changed: true };
    });
