import { UnreconciledSale } from '../types';
import { db, now, toTimestamp } from '../utils/firestore';
import { paginate } from '../utils/pagination';

/** Ventana por defecto del listado cuando no se pide rango. */
const DEFAULT_LIST_DAYS = 90;

const collection = () => db().collection('unreconciledSales');

const mapSale = (id: string, data: FirebaseFirestore.DocumentData): UnreconciledSale => ({
    id,
    localId: data.localId as string,
    localFolio: (data.localFolio as string | null) ?? null,
    reason: data.reason as string,
    total: (data.total as number | undefined) ?? 0,
    payload: (data.payload as Record<string, unknown>) ?? {},
    cashierId: data.cashierId as string,
    cashSessionId: (data.cashSessionId as string | null) ?? null,
    occurredAt: (data.occurredAt as UnreconciledSale['occurredAt']) ?? null,
    resolvedAt: (data.resolvedAt as UnreconciledSale['resolvedAt']) ?? null,
    resolvedBy: (data.resolvedBy as string | null) ?? null,
    createdAt: data.createdAt as UnreconciledSale['createdAt'],
});

/**
 * Registra la venta no conciliada. El id del documento es el `localId` de la
 * caja: reintentar el mismo push no crea un duplicado, y desde el documento se
 * puede volver a la venta original en el SQLite del equipo.
 */
export const saveUnreconciledSale = async (
    input: Omit<UnreconciledSale, 'id' | 'createdAt' | 'resolvedAt' | 'resolvedBy'>,
): Promise<UnreconciledSale> => {
    const timestamp = now();
    const ref = collection().doc(input.localId);
    const payload = {
        ...input,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: timestamp,
    };
    await ref.set(payload, { merge: true });
    return { id: ref.id, ...payload };
};

export const listUnreconciledSales = async (filters: {
    from?: string;
    to?: string;
    includeResolved?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: UnreconciledSale[]; total: number }> => {
    const from = filters.from ??
        new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let query: FirebaseFirestore.Query = collection().where('createdAt', '>=', toTimestamp(from));
    if (filters.to) {
        query = query.where('createdAt', '<=', toTimestamp(filters.to));
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();
    let sales = snapshot.docs.map((doc) => mapSale(doc.id, doc.data()));

    if (!filters.includeResolved) {
        sales = sales.filter((sale) => sale.resolvedAt === null);
    }

    return paginate(sales, filters.page ?? 1, filters.limit ?? 50);
};

export const resolveUnreconciledSale = async (
    id: string,
    resolvedBy: string,
): Promise<void> => {
    await collection().doc(id).update({ resolvedAt: now(), resolvedBy });
};
