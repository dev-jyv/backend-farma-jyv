import { FieldValue } from 'firebase-admin/firestore';
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
): Promise<Product> => db().runTransaction(async (transaction) => {
    await assertNoDuplicate(transaction, data, id);

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
