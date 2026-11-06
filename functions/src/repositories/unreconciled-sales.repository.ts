import { UnreconciledSale, UnreconciledSaleResolution } from '../types';
import { db, now, toTimestamp } from '../utils/firestore';
import { paginate } from '../utils/pagination';

/** Ventana por defecto del listado cuando no se pide rango. */
const DEFAULT_LIST_DAYS = 90;

const collection = () => db().collection('unreconciledSales');

const mapSale = (id: string, data: FirebaseFirestore.DocumentData): UnreconciledSale => ({
    id,
    localId: data.localId as string,
    deviceId: (data.deviceId as string | null | undefined) ?? null,
    localFolio: (data.localFolio as string | null) ?? null,
    reason: data.reason as string,
    total: (data.total as number | undefined) ?? 0,
    payload: (data.payload as Record<string, unknown>) ?? {},
    cashierId: data.cashierId as string,
    cashSessionId: (data.cashSessionId as string | null) ?? null,
    occurredAt: (data.occurredAt as UnreconciledSale['occurredAt']) ?? null,
    resolvedAt: (data.resolvedAt as UnreconciledSale['resolvedAt']) ?? null,
    resolvedBy: (data.resolvedBy as string | null) ?? null,
    resolution: (data.resolution as UnreconciledSaleResolution | null | undefined) ?? null,
    resolutionReason: (data.resolutionReason as string | null | undefined) ?? null,
    resolvedSaleId: (data.resolvedSaleId as string | null | undefined) ?? null,
    createdAt: data.createdAt as UnreconciledSale['createdAt'],
});

/**
 * Id del documento: `<deviceId|cashierId>:<localId>` (SPEC 53). El `localId` lo
 * genera cada caja, así que solo no es único entre cajas; con el prefijo, dos
 * cajas con el mismo `localId` no se pisan. `localId` ya viene validado contra
 * `[A-Za-z0-9_-]` y `deviceId` sin `/`, así que el id nunca abre una subcolección.
 */
export const buildUnreconciledSaleId = (input: {
    deviceId?: string | null;
    cashierId: string;
    localId: string;
}): string => `${input.deviceId || input.cashierId}:${input.localId}`;

/** Firestore reserva `__x__`: un id así no se puede ni leer. */
const isReservedDocId = (id: string): boolean => /^__.*__$/.test(id);

export type NewUnreconciledSale = Omit<
    UnreconciledSale,
    | 'id'
    | 'createdAt'
    | 'resolvedAt'
    | 'resolvedBy'
    | 'resolution'
    | 'resolutionReason'
    | 'resolvedSaleId'
>;

/**
 * Registra la venta no conciliada **una sola vez**. Reenviar la misma (un
 * reintento del POS) devuelve la existente sin tocar `createdAt` ni reabrir una
 * ya resuelta: antes un `set(merge)` reescribía `resolvedAt: null`.
 *
 * También busca el documento con el id viejo (solo `localId`) del mismo cajero,
 * para que una caja que reintenta una venta subida antes de SPEC 53 no la
 * duplique con el id nuevo.
 *
 * `created` dice si el documento es nuevo: solo entonces se audita y se avisa.
 */
export const saveUnreconciledSale = async (
    input: NewUnreconciledSale,
): Promise<{ sale: UnreconciledSale; created: boolean }> => {
    const ref = collection().doc(buildUnreconciledSaleId(input));
    const legacyRef = isReservedDocId(input.localId) ? null : collection().doc(input.localId);

    return db().runTransaction(async (transaction) => {
        const [current, legacy] = await Promise.all([
            transaction.get(ref),
            legacyRef ? transaction.get(legacyRef) : Promise.resolve(null),
        ]);
        if (current.exists) {
            return { sale: mapSale(current.id, current.data()!), created: false };
        }
        if (legacy?.exists && legacy.data()?.cashierId === input.cashierId) {
            return { sale: mapSale(legacy.id, legacy.data()!), created: false };
        }

        const payload = {
            ...input,
            resolvedAt: null,
            resolvedBy: null,
            resolution: null,
            resolutionReason: null,
            resolvedSaleId: null,
            createdAt: now(),
        };
        transaction.create(ref, payload);
        return { sale: { id: ref.id, ...payload }, created: true };
    });
};

export const getUnreconciledSaleById = async (id: string): Promise<UnreconciledSale | null> => {
    if (isReservedDocId(id) || id.includes('/')) {
        return null;
    }
    const snapshot = await collection().doc(id).get();
    return snapshot.exists ? mapSale(snapshot.id, snapshot.data()!) : null;
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

/**
 * Pendientes de cualquier fecha (`resolvedAt == null`), para el correo diario:
 * una venta cobrada hace una semana que nadie resolvió sigue siendo dinero fuera
 * de los reportes. Solo se lee `total` (máscara de campos). Son pocas.
 */
export const summarizePendingUnreconciledSales = async (): Promise<{
    count: number;
    total: number;
}> => {
    const snapshot = await collection().where('resolvedAt', '==', null).select('total').get();
    const cents = snapshot.docs.reduce(
        (sum, doc) => sum + Math.round(((doc.data().total as number | undefined) ?? 0) * 100),
        0,
    );
    return { count: snapshot.size, total: cents / 100 };
};

export type MarkResolvedOutcome =
    | { status: 'resolved'; sale: UnreconciledSale }
    | { status: 'already_resolved'; sale: UnreconciledSale }
    | { status: 'not_found' };

/**
 * Marca la venta como resuelta con precondición dentro de la transacción: si
 * otro usuario (o un doble clic) la resolvió en medio, no se pisa su resolución
 * ni se duplica la auditoría. `withinTransaction` corre solo cuando sí se marca
 * (el servicio escribe ahí la bitácora, atómica con la marca).
 */
export const markUnreconciledSaleResolved = async (
    id: string,
    resolution: {
        action: UnreconciledSaleResolution;
        reason: string | null;
        resolvedBy: string;
        resolvedSaleId: string | null;
    },
    withinTransaction: (
        transaction: FirebaseFirestore.Transaction,
        resolved: UnreconciledSale,
    ) => void,
): Promise<MarkResolvedOutcome> => {
    const ref = collection().doc(id);
    return db().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
            return { status: 'not_found' };
        }
        const current = mapSale(snapshot.id, snapshot.data()!);
        if (current.resolvedAt) {
            return { status: 'already_resolved', sale: current };
        }
        const update = {
            resolvedAt: now(),
            resolvedBy: resolution.resolvedBy,
            resolution: resolution.action,
            resolutionReason: resolution.reason,
            resolvedSaleId: resolution.resolvedSaleId,
        };
        const resolved = { ...current, ...update };
        transaction.update(ref, update);
        withinTransaction(transaction, resolved);
        return { status: 'resolved', sale: resolved };
    });
};

/**
 * No conciliadas **pendientes** de un turno (SPEC 53), para el corte. Una sola
 * igualdad sobre `cashSessionId` (índice de un campo, automático); lo resuelto se
 * descarta en memoria: un turno tiene pocas.
 */
export const listPendingUnreconciledForSession = async (
    cashSessionId: string,
): Promise<UnreconciledSale[]> => {
    const snapshot = await collection().where('cashSessionId', '==', cashSessionId).get();
    return snapshot.docs
        .map((doc) => mapSale(doc.id, doc.data()))
        .filter((sale) => sale.resolvedAt === null);
};
