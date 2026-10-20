import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { badRequest } from './errors';
import { MemoryCache } from './memory-cache';

/**
 * Página resuelta **en Firestore** en vez de en memoria.
 *
 * El patrón que reemplaza —leer la colección filtrada completa, ordenar en el
 * proceso y cortar la página con `paginate()`— cobra una lectura por documento
 * existente para devolver 20 filas, en cada carga de pantalla. Aquí solo se lee
 * hasta el final de la página pedida.
 *
 * Dos condiciones que hay que respetar al usarlo:
 *
 * 1. **La consulta ya viene ordenada.** El mismo objeto se usa para leer y para
 *    contar, así que `count()` cuenta exactamente lo que la paginación puede
 *    listar: si el `orderBy` descarta documentos sin ese campo, los descarta de
 *    los dos lados y `total` no miente.
 * 2. **El orden es el de Firestore (UTF-8)**, no `localeCompare`: los acentos
 *    se ordenan después de la Z. Es el precio de no leer todo, y es el orden
 *    que ya usa el índice.
 *
 * No sirve cuando hay un filtro posterior en memoria (búsqueda de texto): ahí
 * recortar antes de filtrar perdería coincidencias que están más allá de la
 * página.
 */
/**
 * Paginación por cursor (SPEC 08).
 *
 * Uso con cursor:
 *
 *   const { items, total, nextCursor } = await paginateQuery(
 *       query.orderBy('createdAt', 'desc'),
 *       map,
 *       page,
 *       limit,
 *       {
 *           after: filters.after,                       // cursor opaco del cliente
 *           order: [{ field: 'createdAt', direction: 'desc' }],
 *           countCacheKey: cacheKey,                    // opcional, ver abajo
 *       },
 *   );
 *
 * - `order` debe describir EXACTAMENTE los `orderBy` que ya trae la consulta
 *   (mismo orden y dirección). `paginateQuery` agrega por su cuenta el
 *   desempate por id de documento (`__name__`) en la dirección del último
 *   campo, así que los empates no duplican ni pierden filas. Ese `orderBy` sobre
 *   `__name__` usa el mismo índice compuesto que la consulta: no requiere
 *   índices nuevos.
 * - Con `after`, se lee `limit + 1` documentos (el extra solo detecta si hay
 *   más páginas): el costo no depende de la profundidad de la página.
 * - Sin `after` y `page <= 1` es la primera página (también `limit + 1`).
 * - Sin `after` y `page > 1` es la compatibilidad `?page=N`: lee `page × limit`
 *   documentos (el costo de siempre) y aun así devuelve `nextCursor`.
 * - `nextCursor` está ausente en la última página.
 * - El cursor es opaco (base64url de JSON), no estable entre versiones y no se
 *   persiste. Uno manipulado o de otro ordenamiento responde 400; como el
 *   cursor solo se aplica con `startAfter` sobre la consulta ya filtrada, nunca
 *   puede leer fuera del filtro.
 * - `total` sale de `count()`; con `countCacheKey` se cachea 60 s por
 *   combinación de filtros (la clave la arma el llamador con los filtros). Sin
 *   la clave se cuenta en cada llamada. Un cursor posterior no vuelve a contar
 *   si el total está cacheado.
 * - `keep` (opcional) descarta filas que no se pueden filtrar en Firestore.
 *   Se siguen leyendo lotes hasta juntar `limit` filas (máx. `MAX_FILL_READS`
 *   lecturas); `total` no refleja ese filtro.
 *
 * Sin `options` conserva el comportamiento anterior (`page × limit`, sin
 * cursor), para los repositorios que aún no migran.
 *
 * El orden es el de Firestore (UTF-8), no `localeCompare`. No sirve con un
 * filtro de texto posterior que necesite ver todo el rango.
 */
export interface CursorOrder {
    field: string;
    direction: 'asc' | 'desc';
}

export interface PaginateOptions<T> {
    /** Cursor opaco devuelto como `nextCursor` por la página anterior. */
    after?: string;
    /** Campos por los que viene ordenada la consulta (ver arriba). */
    order: CursorOrder[];
    /** Clave de caché del `count()` (60 s). Debe incluir todos los filtros. */
    countCacheKey?: string;
    /** Filtro en memoria que Firestore no puede resolver. */
    keep?: (item: T) => boolean;
}

export interface PaginatedResult<T> {
    items: T[];
    total: number;
    nextCursor?: string;
}

export const COUNT_CACHE_TTL_MS = 60_000;
const MAX_FILL_READS = 5;

const countCache = new MemoryCache<number>(COUNT_CACHE_TTL_MS, 200);

/** Para tests y para invalidar a mano tras una mutación masiva. */
export const clearPaginationCountCache = (): void => countCache.clear();

type CursorValue = string | number | boolean | null | { t: [number, number] };

interface CursorPayload {
    v: CursorValue[];
    id: string;
}

const invalidCursor = () => badRequest('Cursor de paginación inválido');

const toCursorValue = (value: unknown): CursorValue => {
    if (value instanceof Timestamp) {
        return { t: [value.seconds, value.nanoseconds] };
    }
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    throw new Error('Tipo de campo de ordenamiento no soportado por el cursor');
};

export const encodeCursor = (
    doc: FirebaseFirestore.QueryDocumentSnapshot,
    order: CursorOrder[],
): string => {
    const payload: CursorPayload = {
        v: order.map((o) => toCursorValue(doc.get(o.field))),
        id: doc.id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

const isTimestampValue = (value: unknown): value is { t: [number, number] } =>
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { t?: unknown }).t) &&
    (value as { t: unknown[] }).t.length === 2 &&
    (value as { t: unknown[] }).t.every((n) => Number.isInteger(n));

/** Decodifica y valida; cualquier irregularidad es 400, nunca una excepción 500. */
export const decodeCursor = (cursor: string, order: CursorOrder[]): unknown[] => {
    let payload: CursorPayload;
    try {
        if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
            throw new Error('formato');
        }
        payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        throw invalidCursor();
    }

    if (
        !payload ||
        !Array.isArray(payload.v) ||
        payload.v.length !== order.length ||
        typeof payload.id !== 'string' ||
        payload.id.length === 0 ||
        payload.id.includes('/')
    ) {
        throw invalidCursor();
    }

    const values = payload.v.map((value) => {
        if (isTimestampValue(value)) {
            return new Timestamp(value.t[0], value.t[1]);
        }
        if (
            value === null ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            return value;
        }
        throw invalidCursor();
    });

    return [...values, payload.id];
};

const countTotal = async (
    orderedQuery: FirebaseFirestore.Query,
    cacheKey?: string,
): Promise<number> => {
    if (cacheKey) {
        const cached = countCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
    }
    // `count()` se factura por entradas de índice recorridas, no por documento
    // leído: es lo que permite seguir devolviendo `total` sin traer la colección.
    const total = (await orderedQuery.count().get()).data().count;
    if (cacheKey) {
        countCache.set(cacheKey, total);
    }
    return total;
};

export const paginateQuery = async <T>(
    orderedQuery: FirebaseFirestore.Query,
    map: (doc: FirebaseFirestore.QueryDocumentSnapshot) => T,
    page: number,
    limit: number,
    options?: PaginateOptions<T>,
): Promise<PaginatedResult<T>> => {
    if (!options) {
        const upTo = page * limit;
        const [snapshot, total] = await Promise.all([
            orderedQuery.limit(upTo).get(),
            countTotal(orderedQuery),
        ]);
        return { items: snapshot.docs.slice(upTo - limit).map(map), total };
    }

    const { order, after, keep, countCacheKey } = options;
    const lastDirection = order[order.length - 1]?.direction ?? 'asc';
    const cursorQuery = orderedQuery.orderBy(FieldPath.documentId(), lastDirection);
    const cursorValues = after ? decodeCursor(after, order) : undefined;

    const totalPromise = countTotal(orderedQuery, countCacheKey);

    const items: T[] = [];
    let nextCursor: string | undefined;

    if (!cursorValues && page > 1) {
        // `?page=N` por compatibilidad: se lee hasta el final de la página y un
        // documento más para saber si hay siguiente.
        const upTo = page * limit;
        const snapshot = await cursorQuery.limit(upTo + 1).get();
        const pageDocs = snapshot.docs.slice(upTo - limit, upTo);
        items.push(...pageDocs.map(map));
        if (snapshot.docs.length > upTo && pageDocs.length > 0) {
            nextCursor = encodeCursor(pageDocs[pageDocs.length - 1], order);
        }
        return { items, total: await totalPromise, nextCursor };
    }

    let position: unknown[] | undefined = cursorValues;
    let reads = 0;
    let exhausted = false;
    let lastKept: FirebaseFirestore.QueryDocumentSnapshot | undefined;

    while (items.length < limit + 1 && !exhausted) {
        const wanted = limit + 1 - items.length;
        const base = position ? cursorQuery.startAfter(...position) : cursorQuery;
        const snapshot = await base.limit(wanted).get();
        reads += 1;
        exhausted = snapshot.docs.length < wanted;

        for (const doc of snapshot.docs) {
            const mapped = map(doc);
            if (keep && !keep(mapped)) {
                continue;
            }
            if (items.length === limit) {
                // Documento extra: solo prueba que hay otra página.
                items.push(mapped);
                break;
            }
            items.push(mapped);
            lastKept = doc;
        }

        const lastDoc = snapshot.docs[snapshot.docs.length - 1];
        if (lastDoc) {
            position = [...order.map((o) => lastDoc.get(o.field)), lastDoc.id];
        }

        if (!keep) {
            break;
        }
        if (reads >= MAX_FILL_READS && items.length < limit + 1) {
            // Tope de lecturas: devuelve lo que juntó y deja un cursor para
            // seguir desde el último documento leído, aunque la página quede corta.
            if (!exhausted && lastDoc) {
                nextCursor = encodeCursor(lastDoc, order);
            }
            return { items, total: await totalPromise, nextCursor };
        }
    }

    if (items.length > limit) {
        items.pop();
        if (lastKept) {
            nextCursor = encodeCursor(lastKept, order);
        }
    }

    return { items, total: await totalPromise, nextCursor };
};
