import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
    ControlledGroup,
    InventoryEntry,
    InventoryEntryWithDetails,
    InvoiceWithDetails,
    Product,
} from '../types';
import { db } from '../utils/firestore';
import { normalizeLotKey } from '../utils/batch-lot';
import {
    AppError,
    conflict,
    isReleasableError,
    notFound,
    withDefaultSyncCode,
} from '../utils/errors';
import { AuditActor } from './audit.service';
import * as entriesRepo from '../repositories/inventory-entries.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as productsRepo from '../repositories/products.repository';
import * as invoicesService from '../services/invoices.service';
import * as inventoryService from './inventory.service';
import { EntryWarning, RecordedEntry } from './inventory.service';
import * as productsService from './products.service';

/**
 * Entrada de stock desde la caja.
 *
 * No reimplementa nada de inventario: orquesta los servicios que ya existen para
 * cubrir el caso que ninguno cubría solo —recibir **una** partida contra una
 * factura, dando de alta el producto si aún no está en el catálogo—. Vive en su
 * propio módulo con permiso `stockEntry` para que el mostrador pueda recibir
 * mercancía sin que eso le abra conteos, salidas ni el libro de control.
 */

/** Cuántas facturas ofrece el selector de la caja. */
const RECENT_INVOICES_LIMIT = 10;
const MAX_RECENT_INVOICES = 50;

export interface StockEntryResult {
    entry: InventoryEntryWithDetails;
    product: Product;
    /** Existencias del producto después de sumar la partida. */
    stock: number;
    /**
     * Advertencias que no rechazan la partida (SPEC 59), p. ej.
     * `LOT_EXPIRY_MISMATCH`. Van también en `details.warnings`, la forma que usa
     * la regla funcional de la spec; la caja lee cualquiera de las dos.
     */
    warnings?: EntryWarning[];
    details?: { warnings: EntryWarning[] };
}

/**
 * Últimas facturas registradas, de la más reciente a la más vieja. El listado ya
 * viene ordenado por `invoiceDate desc` del repositorio.
 */
export const listRecentInvoices = async (limit?: number): Promise<InvoiceWithDetails[]> => {
    const size = Math.min(Math.max(limit ?? RECENT_INVOICES_LIMIT, 1), MAX_RECENT_INVOICES);
    const { items } = await invoicesService.listInvoices({ page: 1, limit: size });
    return items;
};

/**
 * Llaves de idempotencia de las entradas, con el mismo patrón que las ventas
 * (`saleIdempotencyKeys`): un documento por llave, creado **antes** de tocar
 * catálogo e inventario.
 *
 * El fallo real que esto cubre no es el doble clic —el formulario ya se
 * deshabilita— sino el reintento de la cola: el alta se aplicó, la respuesta se
 * perdió en la red, y el siguiente flush volvía a mandarla. El resultado era un
 * segundo lote con el mismo número y la misma factura, es decir, existencias que
 * no existen.
 *
 * Campos del documento (SPEC 55):
 * - `reservedAt`: cuándo se reservó. **No se reescribe** al retomar: es la marca
 *   contra la que se adopta un producto sobrante y se buscan partidas aplicadas.
 * - `attemptAt`: último intento que la retomó; una reserva retomada hace poco
 *   sigue en curso para los reintentos simultáneos.
 * - `productId`: producto que dio de alta un intento, guardado justo después de
 *   crearlo; el reintento lo reutiliza en vez de crear otro.
 * - `released`: un rechazo de negocio después de dar de alta el producto; el
 *   reintento la retoma sin esperar y conserva el producto.
 * - `expiresAt`: 30 días, para la política TTL de la colección.
 */
const IDEMPOTENCY_COLLECTION = 'stockEntryIdempotencyKeys';

/**
 * Id del documento de la llave (SPEC 54): por caja cuando la caja manda su
 * `deviceId`, para que la llave no cambie si otro usuario inicia sesión y la cola
 * reenvía la entrada. Sin `deviceId` (caja anterior), por usuario, como antes.
 */
const buildIdempotencyDocId = (owner: string, key: string): string => `${owner}:${key}`;

/** Vida de una llave antes de que la política TTL la borre. */
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Antigüedad desde la que una reserva sin `entryId` ya no puede seguir en curso:
 * holgadamente más que el tope de una petición de la API (120 s).
 */
const STALE_RESERVATION_MS = 10 * 60 * 1000;

/** Códigos gRPC con los que Firestore rechaza la reserva de otro intento. */
const ALREADY_EXISTS = 6;
const FAILED_PRECONDITION = 9;

const isFirestoreCode = (error: unknown, code: number): boolean =>
    (error as { code?: unknown } | null)?.code === code;

type IdempotencyKeyDoc = {
    ref: FirebaseFirestore.DocumentReference;
    snapshot: FirebaseFirestore.DocumentSnapshot;
};

/**
 * Documento de la llave. Con `deviceId` se busca también la llave vieja
 * `<usuario>:<llave>` (una sola lectura de los dos): una entrada que una caja
 * anterior reservó o aplicó con ella se sigue reconociendo tras actualizarse.
 */
const loadIdempotencyKey = async (input: {
    userId: string;
    deviceId?: string;
    idempotencyKey?: string;
}): Promise<IdempotencyKeyDoc | null> => {
    if (!input.idempotencyKey) {
        return null;
    }
    const keys = db().collection(IDEMPOTENCY_COLLECTION);
    const legacyRef = keys.doc(buildIdempotencyDocId(input.userId, input.idempotencyKey));
    if (!input.deviceId) {
        return { ref: legacyRef, snapshot: await legacyRef.get() };
    }
    const ref = keys.doc(buildIdempotencyDocId(input.deviceId, input.idempotencyKey));
    const [current, legacy] = await db().getAll(ref, legacyRef);
    return !current.exists && legacy.exists
        ? { ref: legacyRef, snapshot: legacy }
        : { ref, snapshot: current };
};

/**
 * Registra una partida desde la caja. Todo rechazo sale con código de
 * sincronización (SPEC 49): reserva en curso (`ENTRY_IN_PROGRESS`, reintentable),
 * partida dudosa (`ENTRY_AMBIGUOUS`), producto inexistente (`PRODUCT_NOT_FOUND`) y,
 * lo demás, `VALIDATION`.
 */
export const createStockEntry = async (input: StockEntryInput): Promise<StockEntryResult> => {
    try {
        return await applyStockEntry(input);
    } catch (error) {
        throw withDefaultSyncCode(error, 'VALIDATION');
    }
};

type StockEntryInput = Parameters<typeof applyStockEntry>[0];

const applyStockEntry = async (input: {
    invoiceId: string;
    lotNumber: string;
    expiryDate: string;
    quantity: number;
    costPrice?: number;
    productId?: string;
    productUpdate?: Parameters<typeof productsService.updateProduct>[1];
    product?: Omit<Parameters<typeof productsService.createProduct>[0], 'actor'>;
    userId: string;
    roleSlug?: string | null;
    idempotencyKey?: string;
    /** Caja que capturó la entrada (SPEC 54). */
    deviceId?: string;
    /**
     * Momento de la captura en la caja (SPEC 59). Solo lo usa el schema para
     * validar la caducidad contra el día de la captura.
     */
    capturedAt?: string;
}): Promise<StockEntryResult> => {
    // Se comprueba antes de tocar el catálogo: dar de alta un producto para una
    // factura que no existe deja basura en `products` sin nada que la respalde.
    const invoice = await invoicesRepo.getInvoiceById(input.invoiceId);
    if (!invoice) {
        throw notFound('Factura');
    }

    const idempotency = await loadIdempotencyKey(input);
    const idempotencyRef = idempotency?.ref ?? null;

    // Producto que dio de alta un intento anterior de esta misma llave.
    let leftoverProduct: Product | null = null;

    if (idempotency) {
        const previo = idempotency.snapshot;
        const data = previo.data();
        if (data) {
            const entryId = data.entryId as string | undefined;
            if (entryId) {
                return replayEntry(entryId);
            }

            // Se reservó la llave y el intento no terminó. Las reservas anteriores a
            // SPEC 55 solo tienen `createdAt`.
            const reservedAt = (data.reservedAt ?? data.createdAt) as Timestamp | undefined;
            const attemptAt = (data.attemptAt ?? reservedAt) as Timestamp | undefined;
            // Una reserva (o un intento que la retomó) reciente puede seguir en
            // curso: no se toca. Una liberada tras un rechazo se retoma ya.
            if (!reservedAt || !attemptAt ||
                (data.released !== true &&
                    Date.now() - attemptAt.toMillis() <= STALE_RESERVATION_MS)) {
                throw entryInProgress();
            }

            if (!input.productId) {
                leftoverProduct = await findLeftoverProduct({
                    productId: data.productId as string | undefined,
                    sku: input.product!.sku,
                    reservedAt,
                });
            }
            const productId = input.productId ?? leftoverProduct?.id;

            // Lo que importa es si **esta** partida ya está en el servidor, no si
            // el lote existe: el mismo lote llega en otras facturas. Se busca en
            // esta factura, desde la reserva, entre las entradas de esta llave o
            // sin llave (nunca otra partida igual con su propia llave).
            const applied = productId === undefined
                ? { match: null, ambiguous: false }
                : await findAppliedEntry({
                    invoiceId: input.invoiceId,
                    productId,
                    lotNumber: input.lotNumber,
                    quantity: input.quantity,
                    since: reservedAt,
                    idempotencyKey: input.idempotencyKey!,
                });
            if (applied.ambiguous) {
                throw entryAmbiguous();
            }
            if (applied.match) {
                // Ya se aplicó (por este intento o recapturada a mano): se cierra
                // la llave con esa entrada y se devuelve, sin sumar existencias.
                await idempotencyRef!.update(
                    { entryId: applied.match.id },
                    { lastUpdateTime: previo.updateTime! },
                );
                return replayEntry(applied.match.id);
            }
            // La precondición deja pasar a uno solo de dos reintentos simultáneos;
            // el otro ve un intento que acaba de retomarla, es decir, en curso.
            // `reservedAt` y `createdAt` no se tocan.
            await idempotencyRef!.update(
                {
                    attemptAt: new Date(),
                    released: FieldValue.delete(),
                    ...(leftoverProduct ? { productId: leftoverProduct.id } : {}),
                    ...(data.expiresAt ? {} : { expiresAt: idempotencyExpiry() }),
                },
                { lastUpdateTime: previo.updateTime! },
            ).catch((error: unknown) => {
                throw isFirestoreCode(error, FAILED_PRECONDITION) ? entryInProgress() : error;
            });
        } else {
            // `create` falla si otro intento simultáneo ya la reservó: dos flushes en
            // paralelo no pueden aplicar la misma entrada dos veces.
            const reservedAt = new Date();
            await idempotencyRef!.create({
                userId: input.userId,
                ...(input.deviceId ? { deviceId: input.deviceId } : {}),
                createdAt: reservedAt,
                reservedAt,
                expiresAt: idempotencyExpiry(),
            }).catch((error: unknown) => {
                throw isFirestoreCode(error, ALREADY_EXISTS) ? entryInProgress() : error;
            });
        }
    }

    const actor: AuditActor = { userId: input.userId, roleSlug: input.roleSlug ?? null };
    // Producto dado de alta por esta llave (en este intento o en uno anterior).
    let keyProductId = leftoverProduct?.id;
    let product: Product;
    let recorded: RecordedEntry;
    try {
        if (input.productId) {
            product = await resolveExistingProduct(input.productId, input.productUpdate, actor);
        } else if (leftoverProduct) {
            product = leftoverProduct;
        } else {
            // Todo lo que `recordEntry` podría rechazar **después** del alta se
            // revisa antes: un rechazo tras `createProduct` dejaba el producto
            // huérfano y cada reintento chocaba por SKU (SPEC 55).
            await inventoryService.assertActiveSupplier(invoice.supplierId);
            inventoryService.assertValidExpiryAndQuantity([input]);
            await productsService.assertProductsCreatable([input.product!]);

            // `createProduct` recibe el actor dentro del mismo objeto de entrada.
            product = await productsService.createProduct({ ...input.product!, actor });
            keyProductId = product.id;
            if (idempotencyRef) {
                // Justo después del alta: el reintento reutiliza este producto en
                // vez de crear otro. Si la función muere antes de esta escritura,
                // el reintento lo adopta por SKU (creado después de `reservedAt`).
                await idempotencyRef.set({ productId: product.id }, { merge: true });
            }
        }

        recorded = await inventoryService.recordEntry({
            invoiceId: input.invoiceId,
            items: [
                {
                    productId: product.id,
                    lotNumber: input.lotNumber,
                    expiryDate: input.expiryDate,
                    quantity: input.quantity,
                    costPrice: input.costPrice,
                },
            ],
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
        });
    } catch (error) {
        // Un rechazo de negocio no registró ninguna entrada: se libera la llave para
        // que el reintento diga el motivo real. Cualquier otro error (p. ej. un
        // timeout tras el commit) pudo haberla aplicado, así que la reserva se queda.
        if (idempotencyRef && isReleasableError(error)) {
            await releaseIdempotencyKey(idempotencyRef, keyProductId);
        }
        throw error;
    }

    const { warnings, ...entry } = recorded;
    if (idempotencyRef) {
        // Cierra la llave en cuanto existe la entrada: de aquí en adelante el
        // reintento la devuelve en vez de crear otra.
        await idempotencyRef.set({ entryId: entry.id }, { merge: true });
    }

    // `recordEntry` ya incrementó `totalStock` dentro de su transacción; se relee
    // para devolver la cifra con la que la caja pinta "quedará en N".
    const stock = await productsService.getProduct(product.id);

    return {
        entry,
        product,
        stock: stock.stock,
        ...(warnings?.length ? { warnings, details: { warnings } } : {}),
    };
};

const idempotencyExpiry = (): Date => new Date(Date.now() + IDEMPOTENCY_TTL_MS);

/**
 * Libera la llave tras un rechazo de negocio. Si esta llave ya dio de alta su
 * producto, el documento se conserva marcado `released`: borrarlo haría que el
 * reintento intentara crear el producto otra vez y chocara por SKU para siempre.
 */
const releaseIdempotencyKey = async (
    ref: FirebaseFirestore.DocumentReference,
    productId: string | undefined,
): Promise<void> => {
    const release = productId
        ? ref.set({ productId, released: true }, { merge: true })
        : ref.delete();
    await release.catch(() => undefined);
};

/**
 * Producto que dejó un intento anterior de la llave: el que quedó anotado en ella
 * o, si la función murió antes de anotarlo, el de ese SKU creado **después** de
 * la reserva. Uno anterior con ese SKU es otro producto, y `createProduct` debe
 * decir que el SKU choca.
 */
const findLeftoverProduct = async (params: {
    productId?: string;
    sku: string;
    reservedAt: Timestamp;
}): Promise<Product | null> => {
    if (params.productId) {
        const anotado = await productsRepo.getProductById(params.productId);
        if (anotado) {
            return anotado;
        }
    }
    const bySku = await productsRepo.findProductBySku(params.sku);
    return bySku && bySku.createdAt.toMillis() >= params.reservedAt.toMillis() ? bySku : null;
};

const HALF_RECORDED_MESSAGE =
    'Esta entrada quedó a medio registrar en un intento anterior. ' +
    'Revisa el lote en inventario antes de volver a capturarla.';

/**
 * Ya hay partidas de ese producto y lote en la factura, con otra cantidad: no se
 * sabe si es esta corregida o una distinta. Lo decide una persona.
 */
const entryAmbiguous = () => conflict(HALF_RECORDED_MESSAGE, 'ENTRY_AMBIGUOUS');

/**
 * Otro intento con la misma llave reservó hace poco y puede seguir en curso. No es
 * un rechazo: la caja la deja pendiente y reintenta (SPEC 49). El mensaje no cambia
 * para que una caja anterior a los códigos lo siga reconociendo.
 */
const entryInProgress = () => new AppError(409, 'CONFLICT', HALF_RECORDED_MESSAGE, {
    syncCode: 'ENTRY_IN_PROGRESS',
    retryable: true,
});

const replayEntry = async (entryId: string): Promise<StockEntryResult> => {
    const entry = await inventoryService.getEntry(entryId);
    const product = await productsService.getProduct(entry.items[0]!.productId);
    return { entry, product: product as unknown as Product, stock: product.stock };
};

/**
 * Busca, en la factura y desde la reserva, una entrada de esta llave (o sin llave,
 * anterior a SPEC 55 o capturada sin ella) con la misma partida
 * (producto, lote y cantidad). Si hay partidas de ese producto y lote pero con
 * otra cantidad, no se sabe si es esta corregida o una distinta: `ambiguous`.
 */
const findAppliedEntry = async (params: {
    invoiceId: string;
    productId: string;
    lotNumber: string;
    quantity: number;
    since: Timestamp;
    idempotencyKey: string;
}): Promise<{ match: InventoryEntry | null; ambiguous: boolean }> => {
    // Mismo lote aunque venga escrito distinto ("abc 12" / "ABC12", SPEC 59).
    const lot = normalizeLotKey(params.lotNumber);
    const entries = (await entriesRepo.listInventoryEntries({ invoiceId: params.invoiceId }))
        .filter((entry) => entry.createdAt.toMillis() >= params.since.toMillis())
        // Una entrada con otra llave es otra partida, aunque sea idéntica: dos
        // partidas iguales en una factura entran las dos (SPEC 55).
        .filter((entry) => !entry.idempotencyKey ||
            entry.idempotencyKey === params.idempotencyKey);
    const sameLot = entries.filter((entry) => entry.items.some(
        (item) => item.productId === params.productId && normalizeLotKey(item.lotNumber) === lot,
    ));
    const match = sameLot.find((entry) => entry.items.some(
        (item) => item.productId === params.productId &&
            normalizeLotKey(item.lotNumber) === lot &&
            item.quantity === params.quantity,
    )) ?? null;
    return { match, ambiguous: !match && sameLot.length > 0 };
};

/**
 * Aplica las correcciones que el cajero haya hecho sobre un producto existente.
 * Sin cambios, no se toca el documento: un `PATCH` vacío ensuciaría la bitácora
 * de auditoría con actualizaciones que no cambiaron nada.
 */
const resolveExistingProduct = async (
    productId: string,
    update: Parameters<typeof productsService.updateProduct>[1] | undefined,
    actor: AuditActor,
): Promise<Product> => {
    // Los 404 de `updateProduct` y `getProduct` también pueden ser de la categoría
    // o del proveedor: el producto se comprueba antes para darle a la caja su código.
    // Una lectura más por partida, a ritmo de captura humana.
    if (!await productsRepo.getProductById(productId)) {
        throw notFound('Producto', 'PRODUCT_NOT_FOUND');
    }
    if (update && Object.keys(update).length > 0) {
        return productsService.updateProduct(productId, update, actor);
    }
    const product = await productsService.getProduct(productId);
    return product as unknown as Product & { controlledGroup?: ControlledGroup };
};
