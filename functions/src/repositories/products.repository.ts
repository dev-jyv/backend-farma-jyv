import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { Product } from '../types';
import { badRequest, conflict } from '../utils/errors';
import { PaginatedResult, paginateQuery } from '../utils/firestore-pagination';
import { db, now, toTimestamp } from '../utils/firestore';
import { boxConfigProblem } from '../utils/box-sale';

const collection = () => db().collection('products');

type UniqueField = 'sku' | 'name' | 'barcode' | 'boxBarcode';

const UNIQUE_FIELD_LABELS: Record<UniqueField, string> = {
    sku: 'SKU',
    name: 'nombre',
    barcode: 'código de barras',
    boxBarcode: 'código de barras de caja',
};

const findDuplicate = async (
    transaction: FirebaseFirestore.Transaction,
    field: UniqueField,
    value: string,
): Promise<Product | null> => {
    const snapshot = await transaction.get(collection().where(field, '==', value).limit(1));
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Product;
};

// Corre dentro de la misma transacción que la escritura para evitar que dos
// altas/ediciones concurrentes con el mismo sku/nombre/barcode pasen ambas.
//
// Los códigos de barras comparten espacio: un escaneo tiene que resolver a un
// solo producto y a una sola unidad (pieza o caja). Por eso `boxBarcode` se
// busca contra `barcode`, `sku` y otros `boxBarcode`, y un `barcode` nuevo
// también contra los `boxBarcode` de los demás.
const assertNoDuplicate = async (
    transaction: FirebaseFirestore.Transaction,
    data: { sku?: string; name?: string; barcode?: string; boxBarcode?: string | null },
    excludeId?: string,
): Promise<void> => {
    const checks: Array<[UniqueField, UniqueField, string | null | undefined]> = [
        ['sku', 'sku', data.sku],
        ['name', 'name', data.name],
        ['barcode', 'barcode', data.barcode],
        ['barcode', 'boxBarcode', data.barcode],
        ['boxBarcode', 'boxBarcode', data.boxBarcode],
        ['boxBarcode', 'barcode', data.boxBarcode],
        ['boxBarcode', 'sku', data.boxBarcode],
    ];

    for (const [field, against, value] of checks) {
        if (!value) {
            continue;
        }
        const duplicate = await findDuplicate(transaction, against, value);
        if (duplicate && duplicate.id !== excludeId) {
            throw conflict(`Ya existe un producto con ese ${UNIQUE_FIELD_LABELS[field]}`);
        }
    }
};

/**
 * Campos que aceptan `null` en una edición para quitarse del documento: los de
 * caja y el grupo COFEPRIS (desclasificar, SPEC 64). Se borran en vez de guardar
 * `null` porque el resto del sistema lee la ausencia como "sin caja" / "sin grupo".
 */
const NULLABLE_FIELDS = ['boxQuantity', 'boxPrice', 'boxBarcode', 'controlledGroup'] as const;

type NullablePatch = {
    boxQuantity?: number | null;
    boxPrice?: number | null;
    boxBarcode?: string | null;
    controlledGroup?: Product['controlledGroup'] | null;
};

export type ProductPatch = Partial<Omit<
    Product,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
    | 'salePriceChangedAt'
    | 'isActiveChangedAt'
    | typeof NULLABLE_FIELDS[number]
>> & NullablePatch;

/**
 * Campos que el panel decide y que una caja con copia vieja no debe revertir
 * (SPEC 56): un precio subido en el panel, o un producto dado de baja.
 */
const GUARDED_CATALOG_FIELDS = ['salePrice', 'isActive'] as const;

const CHANGED_AT_FIELD: Record<typeof GUARDED_CATALOG_FIELDS[number], string> = {
    salePrice: 'salePriceChangedAt',
    isActive: 'isActiveChangedAt',
};

/** Valor vigente de los campos protegidos, para que la caja ofrezca "usar el del panel". */
export interface CatalogConflict {
    current: { salePrice: number; isActive: boolean };
}

export interface ProductUpdateResult {
    product: Product;
    /** `null` si no hubo conflicto; si lo hubo, los campos protegidos no se escribieron. */
    conflict: CatalogConflict | null;
}

const assertBoxConfig = (
    product: Parameters<typeof boxConfigProblem>[0],
    options?: Parameters<typeof boxConfigProblem>[1],
): void => {
    const problem = boxConfigProblem(product, options);
    if (problem) {
        throw badRequest(problem);
    }
};

export const listProducts = async (filters: {
    categoryId?: string;
    activeOnly?: boolean;
    limit?: number;
    /** Solo productos con `updatedAt` posterior a esta fecha (sync incremental). */
    updatedSince?: string;
}): Promise<Product[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.categoryId) {
        query = query.where('categoryId', '==', filters.categoryId);
    } else if (filters.activeOnly !== false) {
        query = query.where('isActive', '==', true);
    }

    if (filters.updatedSince) {
        query = query.where('updatedAt', '>=', toTimestamp(filters.updatedSince));
    }

    if (filters.limit) {
        query = query.limit(filters.limit);
    }

    const snapshot = await query.get();
    let products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Product));

    if (filters.categoryId && filters.activeOnly !== false) {
        products = products.filter((product) => product.isActive);
    }

    products.sort((a, b) => a.name.localeCompare(b.name));

    return products;
};

/**
 * Página del catálogo resuelta **en Firestore**, no en memoria.
 *
 * El listado sin búsqueda traía todos los productos activos y paginaba 20 en
 * memoria: con 5,000 productos eran 5,000 lecturas facturadas para devolver 20,
 * en cada carga de la pantalla. Ver `paginateQuery` para el mecanismo y sus
 * dos condiciones.
 *
 * Los índices necesarios ya existen (`products [isActive, name]`,
 * `[isActive, categoryId, name]`, `[categoryId, name]`), así que los dos
 * filtros van a la consulta y no queda nada por descartar en memoria.
 */
export const listProductsPage = async (filters: {
    categoryId?: string;
    activeOnly?: boolean;
    page: number;
    limit: number;
    /** Cursor de la página anterior (SPEC 08). */
    after?: string;
}): Promise<PaginatedResult<Product>> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.activeOnly !== false) {
        query = query.where('isActive', '==', true);
    }
    if (filters.categoryId) {
        query = query.where('categoryId', '==', filters.categoryId);
    }

    return paginateQuery(
        query.orderBy('name', 'asc'),
        (doc) => ({ id: doc.id, ...doc.data() } as Product),
        filters.page,
        filters.limit,
        {
            after: filters.after,
            order: [{ field: 'name', direction: 'asc' }],
            countCacheKey: `products:${filters.activeOnly !== false}:${filters.categoryId ?? ''}`,
        },
    );
};

/** SKU exacto: una consulta indexada con `limit(1)` (1 lectura como máximo). */
export const findProductBySku = async (sku: string): Promise<Product | null> => {
    const normalized = sku.trim();
    if (!normalized) {
        return null;
    }
    const snap = await collection().where('sku', '==', normalized).limit(1).get();
    if (snap.empty) {
        return null;
    }
    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() } as Product;
};

export const findProductBySkuOrBarcode = async (term: string): Promise<Product | null> => {
    const normalized = term.trim();
    if (!normalized) {
        return null;
    }

    const skuSnap = await collection().where('sku', '==', normalized).limit(1).get();
    if (!skuSnap.empty) {
        const doc = skuSnap.docs[0];
        return { id: doc.id, ...doc.data() } as Product;
    }

    const barcodeSnap = await collection().where('barcode', '==', normalized).limit(1).get();
    if (!barcodeSnap.empty) {
        const doc = barcodeSnap.docs[0];
        return { id: doc.id, ...doc.data() } as Product;
    }

    return null;
};

export const getProductById = async (id: string): Promise<Product | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Product;
};

/**
 * Varios productos con una sola lectura en bloque (`getAll`). Devuelve un mapa
 * id -> producto; los ids que no existen no aparecen.
 */
export const getProductsByIds = async (ids: string[]): Promise<Map<string, Product>> => {
    const unique = [...new Set(ids)];
    const result = new Map<string, Product>();
    if (unique.length === 0) {
        return result;
    }
    const docs = await db().getAll(...unique.map((id) => collection().doc(id)));
    for (const doc of docs) {
        if (doc.exists) {
            result.set(doc.id, { id: doc.id, ...doc.data() } as Product);
        }
    }
    return result;
};

export const createProduct = async (
    data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Product> => db().runTransaction(async (transaction) => {
    assertBoxConfig(data);
    await assertNoDuplicate(transaction, data);

    const timestamp = now();
    const ref = collection().doc();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    transaction.create(ref, payload);
    return { id: ref.id, ...payload };
});

export const updateProduct = async (
    id: string,
    data: ProductPatch,
): Promise<Product> => (await updateProductChecked(id, data)).product;

/**
 * Edición de un producto con la precondición opcional de SPEC 56.
 *
 * Con `baseUpdatedAt` (el `updatedAt` de la copia de la caja): si `salePrice` o
 * `isActive` cambiaron en el servidor **después** de esa fecha y el PATCH trae
 * alguno de los dos con un valor distinto del vigente, esos dos campos no se
 * escriben y se devuelve `conflict` con el valor actual. Los demás campos se
 * aplican igual, en la misma transacción: el cajero que corrigió la
 * concentración no la pierde porque el admin subió el precio.
 *
 * La decisión se toma contra el documento leído dentro de la transacción, no
 * contra una lectura previa.
 */
export const updateProductChecked = async (
    id: string,
    data: ProductPatch,
    options: { baseUpdatedAt?: string } = {},
): Promise<ProductUpdateResult> => db().runTransaction(async (transaction) => {
    await assertNoDuplicate(transaction, data, id);

    const docRef = collection().doc(id);
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
        throw new Error('Producto no encontrado tras actualizar');
    }
    const stored = snapshot.data() as Record<string, unknown>;

    const catalogConflict = detectCatalogConflict(stored, data, options.baseUpdatedAt);

    // `null` en un campo de `NULLABLE_FIELDS` lo quita del documento; `undefined` no lo toca.
    const merged: Record<string, unknown> = { ...stored };
    const write: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined) {
            continue;
        }
        if (catalogConflict && (GUARDED_CATALOG_FIELDS as readonly string[]).includes(key)) {
            continue;
        }
        if (value === null && (NULLABLE_FIELDS as readonly string[]).includes(key)) {
            delete merged[key];
            write[key] = FieldValue.delete();
            continue;
        }
        merged[key] = value;
        write[key] = value;
    }

    // La caja se valida contra el documento leído aquí, y solo cuando la
    // escritura toca la caja. Un cambio de `salePrice` (u otro campo) nunca se
    // rechaza por la caja: el POS sube precios editados sin red y un push
    // rechazado atora su cola. Si deja la caja más cara que las piezas, el
    // servicio lo deja en la bitácora (`product.box_price_review`).
    const writesBoxPrice = 'boxQuantity' in write || 'boxPrice' in write;
    if (writesBoxPrice || 'boxBarcode' in write) {
        assertBoxConfig(merged as unknown as Product, { checkPrice: writesBoxPrice });
    }

    // Un conflicto que no deja nada más que escribir no toca el documento: subir
    // `updatedAt` sin cambio haría que todas las cajas lo volvieran a bajar.
    if (catalogConflict && Object.keys(write).length === 0) {
        return { product: { ...stored, id } as Product, conflict: catalogConflict };
    }

    const timestamp = now();
    // Cuándo cambió de verdad el precio o el estado: solo si el valor se movió.
    for (const field of GUARDED_CATALOG_FIELDS) {
        if (field in write && write[field] !== stored[field]) {
            write[CHANGED_AT_FIELD[field]] = timestamp;
            merged[CHANGED_AT_FIELD[field]] = timestamp;
        }
    }
    transaction.update(docRef, { ...write, updatedAt: timestamp });
    return {
        product: { ...merged, id, updatedAt: timestamp } as Product,
        conflict: catalogConflict,
    };
});

/** Milisegundos enteros: `baseUpdatedAt` viaja como ISO (ms) y el Timestamp trae µs. */
const changedAtMillis = (value: unknown): number | null =>
    value instanceof Timestamp ? Math.floor(value.toMillis()) : null;

const detectCatalogConflict = (
    stored: Record<string, unknown>,
    data: ProductPatch,
    baseUpdatedAt: string | undefined,
): CatalogConflict | null => {
    if (!baseUpdatedAt) {
        return null;
    }
    const baseMs = Date.parse(baseUpdatedAt);
    if (!Number.isFinite(baseMs)) {
        return null;
    }
    const touchesGuarded = GUARDED_CATALOG_FIELDS.some((field) =>
        data[field] !== undefined && data[field] !== stored[field]);
    if (!touchesGuarded) {
        return null;
    }
    const changedAfterBase = GUARDED_CATALOG_FIELDS.some((field) => {
        const changedAt = changedAtMillis(stored[CHANGED_AT_FIELD[field]]);
        return changedAt !== null && changedAt > baseMs;
    });
    if (!changedAfterBase) {
        return null;
    }
    return {
        current: {
            salePrice: stored.salePrice as number,
            isActive: stored.isActive as boolean,
        },
    };
};
