import { StockMovement, StockMovementType } from '../types';
import { db, toTimestamp } from '../utils/firestore';
import { PaginatedResult, paginateQuery } from '../utils/firestore-pagination';

const collection = () => db().collection('stockMovements');

type MovementFilters = {
    productId?: string;
    type?: StockMovementType;
    from?: string;
    to?: string;
};

const buildMovementsQuery = (filters: MovementFilters): FirebaseFirestore.Query => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.productId) {
        query = query.where('productId', '==', filters.productId);
    }

    if (filters.type) {
        query = query.where('type', '==', filters.type);
    }

    if (filters.from) {
        query = query.where('createdAt', '>=', toTimestamp(filters.from));
    }

    if (filters.to) {
        query = query.where('createdAt', '<=', toTimestamp(filters.to));
    }

    return query.orderBy('createdAt', 'desc');
};

const mapMovement = (doc: FirebaseFirestore.QueryDocumentSnapshot) =>
    ({ id: doc.id, ...doc.data() } as StockMovement);

/** Lectura completa: solo para la búsqueda de texto, que filtra en memoria. */
export const listStockMovements = async (filters: MovementFilters): Promise<StockMovement[]> => {
    const snapshot = await buildMovementsQuery(filters).get();
    return snapshot.docs.map(mapMovement);
};

/**
 * Página por cursor (SPEC 08). Usa los mismos índices que `listStockMovements`
 * (los filtros y el `orderBy createdAt desc` no cambian).
 */
export const listStockMovementsPage = async (
    filters: MovementFilters & { page: number; limit: number; after?: string },
): Promise<PaginatedResult<StockMovement>> =>
    paginateQuery(buildMovementsQuery(filters), mapMovement, filters.page, filters.limit, {
        after: filters.after,
        order: [{ field: 'createdAt', direction: 'desc' }],
        countCacheKey: [
            'movements',
            filters.productId ?? '',
            filters.type ?? '',
            filters.from ?? '',
            filters.to ?? '',
        ].join(':'),
    });

export const findEntryReferenceByBatchId = async (
    batchId: string,
): Promise<string | null> => {
    const snapshot = await collection()
        .where('batchId', '==', batchId)
        .where('type', '==', 'entry')
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const movement = snapshot.docs[0].data() as StockMovement;
    return movement.referenceId ?? null;
};

/**
 * Movimientos de un producto desde `since`, los más recientes primero y
 * acotados a `limit`. Índice `[productId, createdAt DESC]`.
 */
export const listStockMovementsSince = async (
    productId: string,
    since: Date,
    limit: number,
): Promise<StockMovement[]> => {
    const snapshot = await collection()
        .where('productId', '==', productId)
        .where('createdAt', '>=', since)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
    return snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as StockMovement),
    );
};
