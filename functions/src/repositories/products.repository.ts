import { FieldValue } from 'firebase-admin/firestore';
import { Product } from '../types';
import { AppError, badRequest } from '../utils/errors';
import { PaginatedResult, paginateQuery } from '../utils/firestore-pagination';
import { db, now, toTimestamp } from '../utils/firestore';
import { boxConfigProblem } from '../utils/box-sale';
import { productNameKey } from '../utils/product-match';
import { SyncErrorCode } from '../constants/sync-error-codes';

const collection = () => db().collection('products');

type UniqueField = 'sku' | 'name' | 'barcode' | 'boxBarcode';

const UNIQUE_FIELD_LABELS: Record<UniqueField, string> = {
    sku: 'SKU',
    name: 'nombre',
    barcode: 'código de barras',
    boxBarcode: 'código de barras de caja',
};

/**
 * Código que lee la caja en `details.code` (SPEC 60). El SKU y el nombre tienen el
 * suyo porque la caja decide distinto con cada uno; un código de barras repetido
 * es un duplicado genérico.
 */
const DUPLICATE_SYNC_CODES: Record<UniqueField, SyncErrorCode> = {
    sku: 'PRODUCT_SKU_TAKEN',
    name: 'PRODUCT_NAME_TAKEN',
    barcode: 'PRODUCT_DUPLICATE',
    boxBarcode: 'PRODUCT_DUPLICATE',
};

/** Lo que la caja necesita del producto existente para decidir si es el mismo. */
export interface ExistingProductSummary {
    id: string;
    name: string;
    sku: string;
    barcode: string | null;
}

export const summarizeExistingProduct = (product: Product): ExistingProductSummary => ({
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? null,
});

/**
 * 409 de producto duplicado (SPEC 60). El mensaje no cambia —una caja anterior
 * lo sigue reconociendo por el texto—; lo nuevo va en `details`: el código y el
 * producto existente, para que la caja lo consulte y decida si lo adopta.
 */
export const duplicateProductError = (
    field: UniqueField,
    existing: Product,
    syncCode: SyncErrorCode = DUPLICATE_SYNC_CODES[field],
    message = `Ya existe un producto con ese ${UNIQUE_FIELD_LABELS[field]}`,
): AppError => new AppError(409, 'CONFLICT', message, {
    syncCode,
    details: { existing: summarizeExistingProduct(existing) },
});

type QueryReader = (query: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>;

const toProduct = (doc: FirebaseFirestore.QueryDocumentSnapshot): Product =>
    ({ id: doc.id, ...doc.data() } as Product);

const findDuplicate = async (
    read: QueryReader,
    field: UniqueField,
    value: string,
    excludeId?: string,
): Promise<Product | null> => {
    // `limit(2)`: en una edición el primero puede ser el propio producto.
    const snapshot = await read(collection().where(field, '==', value).limit(2));
    const doc = snapshot.docs.find((candidate) => candidate.id !== excludeId);
    return doc ? toProduct(doc) : null;
};

/**
 * Producto **activo** con el mismo `nameKey` (SPEC 60): nombre + concentración
 * normalizados, así que "Paracetamol 500 mg" choca con "paracetamol  500MG" y no
 * con "Paracetamol 1 g". Uno inactivo no choca.
 *
 * Mientras un producto no tenga `nameKey` (anterior al backfill), la comparación
 * cae a su nombre exacto: se busca por `name` y se compara su clave calculada.
 */
const findNameKeyDuplicate = async (
    read: QueryReader,
    product: { name: string; concentration?: string | null },
    excludeId?: string,
): Promise<Product | null> => {
    const nameKey = productNameKey(product.name, product.concentration);
    if (!nameKey) {
        return null;
    }
    const [byKey, byName] = await Promise.all([
        read(collection()
            .where('nameKey', '==', nameKey)
            .where('isActive', '==', true)
            .limit(2)),
        read(collection()
            .where('name', '==', product.name)
            .where('isActive', '==', true)
            .limit(10)),
    ]);
    const keyed = byKey.docs.find((doc) => doc.id !== excludeId);
    if (keyed) {
        return toProduct(keyed);
    }
    const legacy = byName.docs.find((doc) => {
        const data = doc.data();
        return doc.id !== excludeId && !data.nameKey &&
            productNameKey(data.name as string, data.concentration as string | undefined) ===
                nameKey;
    });
    return legacy ? toProduct(legacy) : null;
};

type UniqueData = {
    sku?: string;
    /** Con `name` se revisa el `nameKey` contra los productos activos. */
    name?: string;
    concentration?: string | null;
    barcode?: string;
    boxBarcode?: string | null;
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
    data: UniqueData,
    excludeId?: string,
): Promise<void> => assertNoDuplicateWith((query) => transaction.get(query), data, excludeId);

const assertNoDuplicateWith = async (
    read: QueryReader,
    data: UniqueData,
    excludeId?: string,
): Promise<void> => {
    if (data.sku) {
        const duplicate = await findDuplicate(read, 'sku', data.sku, excludeId);
        if (duplicate) {
            throw duplicateProductError('sku', duplicate);
        }
    }
    if (data.name) {
        await assertNameKeyFree(read, data as { name: string }, excludeId);
    }

    const codeChecks: Array<[UniqueField, UniqueField, string | null | undefined]> = [
        ['barcode', 'barcode', data.barcode],
        ['barcode', 'boxBarcode', data.barcode],
        ['boxBarcode', 'boxBarcode', data.boxBarcode],
        ['boxBarcode', 'barcode', data.boxBarcode],
        ['boxBarcode', 'sku', data.boxBarcode],
    ];
    for (const [field, against, value] of codeChecks) {
        if (!value) {
            continue;
        }
        const duplicate = await findDuplicate(read, against, value, excludeId);
        if (duplicate) {
            throw duplicateProductError(field, duplicate);
        }
    }
};

const assertNameKeyFree = async (
    read: QueryReader,
    product: { name: string; concentration?: string | null },
    excludeId?: string,
): Promise<void> => {
    const duplicate = await findNameKeyDuplicate(read, product, excludeId);
    if (duplicate) {
        throw duplicateProductError('name', duplicate);
    }
};

/**
 * La misma revisión de unicidad, **fuera** de transacción. No sustituye a la de
 * `createProduct` (que es la que cierra la carrera): sirve para rechazar una
 * entrada con varios productos en línea antes de dar de alta el primero, y no
 * dejar huérfanos cuando choca el segundo (SPEC 55).
 */
export const assertUniqueOutsideTransaction = (data: UniqueData): Promise<void> =>
    assertNoDuplicateWith((query) => query.get(), data);

/** Campos de caja que aceptan `null` en una edición para quitarse del documento. */
const BOX_FIELDS = ['boxQuantity', 'boxPrice', 'boxBarcode'] as const;

type BoxPatch = {
    boxQuantity?: number | null;
    boxPrice?: number | null;
    boxBarcode?: string | null;
};

export type ProductPatch = Partial<Omit<
    Product,
    'id' | 'createdAt' | 'updatedAt' | typeof BOX_FIELDS[number]
>> & BoxPatch;

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
    // Un alta inactiva no compite por el nombre (SPEC 60): solo los activos chocan.
    await assertNoDuplicate(transaction, {
        ...data,
        name: data.isActive === false ? undefined : data.name,
    });

    const timestamp = now();
    const ref = collection().doc();
    const payload = {
        ...data,
        nameKey: productNameKey(data.name, data.concentration),
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    transaction.create(ref, payload);
    return { id: ref.id, ...payload };
});

export const updateProduct = async (
    id: string,
    data: ProductPatch,
): Promise<Product> => db().runTransaction(async (transaction) => {
    const docRef = collection().doc(id);
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
        throw new Error('Producto no encontrado tras actualizar');
    }

    // `null` en un campo de caja lo quita del documento; `undefined` no lo toca.
    const merged: Record<string, unknown> = { ...snapshot.data() };
    const write: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined) {
            continue;
        }
        if (value === null && (BOX_FIELDS as readonly string[]).includes(key)) {
            delete merged[key];
            write[key] = FieldValue.delete();
            continue;
        }
        merged[key] = value;
        write[key] = value;
    }

    // `nameKey` (SPEC 60) se calcula del documento resultante. Se revisa contra
    // los activos solo si cambia el nombre o la concentración, o si el producto
    // se reactiva: un cambio de precio no choca por un duplicado anterior.
    const nameKey = productNameKey(merged.name as string, merged.concentration as string);
    const isActive = merged.isActive !== false;
    const competesForName = isActive && ('name' in write || 'concentration' in write ||
        (write.isActive === true && snapshot.data()!.isActive === false));
    await assertNoDuplicate(transaction, {
        sku: data.sku,
        barcode: data.barcode,
        boxBarcode: data.boxBarcode,
        ...(competesForName
            ? { name: merged.name as string, concentration: merged.concentration as string }
            : {}),
    }, id);
    if (merged.nameKey !== nameKey) {
        merged.nameKey = nameKey;
        write.nameKey = nameKey;
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

    const timestamp = now();
    transaction.update(docRef, { ...write, updatedAt: timestamp });
    return { ...merged, id, updatedAt: timestamp } as Product;
});
