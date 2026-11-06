import { Timestamp } from 'firebase-admin/firestore';
import {
    ControlledGroup,
    InventoryEntry,
    InventoryEntryWithDetails,
    InvoiceWithDetails,
    Product,
} from '../types';
import { db } from '../utils/firestore';
import { AppError, conflict, notFound, withDefaultSyncCode } from '../utils/errors';
import { AuditActor } from './audit.service';
import * as entriesRepo from '../repositories/inventory-entries.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as productsRepo from '../repositories/products.repository';
import * as invoicesService from '../services/invoices.service';
import * as inventoryService from './inventory.service';
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
 * (`saleIdempotencyKeys`): documento por `usuario:llave`, creado **antes** de
 * tocar catálogo e inventario.
 *
 * El fallo real que esto cubre no es el doble clic —el formulario ya se
 * deshabilita— sino el reintento de la cola: el alta se aplicó, la respuesta se
 * perdió en la red, y el siguiente flush volvía a mandarla. El resultado era un
 * segundo lote con el mismo número y la misma factura, es decir, existencias que
 * no existen.
 */
const IDEMPOTENCY_COLLECTION = 'stockEntryIdempotencyKeys';

const buildIdempotencyDocId = (userId: string, key: string): string => `${userId}:${key}`;

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
}): Promise<StockEntryResult> => {
    // Se comprueba antes de tocar el catálogo: dar de alta un producto para una
    // factura que no existe deja basura en `products` sin nada que la respalde.
    const invoice = await invoicesRepo.getInvoiceById(input.invoiceId);
    if (!invoice) {
        throw notFound('Factura');
    }

    const idempotencyRef = input.idempotencyKey
        ? db()
            .collection(IDEMPOTENCY_COLLECTION)
            .doc(buildIdempotencyDocId(input.userId, input.idempotencyKey))
        : null;

    // Producto que dejó un intento que murió entre el alta y la entrada.
    let leftoverProduct: Product | null = null;

    if (idempotencyRef) {
        const previo = await idempotencyRef.get();
        if (previo.exists) {
            const entryId = previo.data()?.entryId as string | undefined;
            if (!entryId) {
                // Se reservó la llave y el intento no terminó. Una reserva reciente
                // puede seguir en curso: no se toca.
                const reservedAt = previo.data()?.createdAt as Timestamp | undefined;
                if (!reservedAt || Date.now() - reservedAt.toMillis() <= STALE_RESERVATION_MS) {
                    throw entryInProgress();
                }

                // Solo cuenta como sobrante de este intento un producto dado de alta
                // **después** de reservar la llave. Uno anterior con ese SKU es
                // otro producto, y `createProduct` debe decir que el SKU choca.
                const bySku = input.productId
                    ? null
                    : await productsRepo.findProductBySku(input.product!.sku);
                leftoverProduct = bySku &&
                    bySku.createdAt.toMillis() >= reservedAt.toMillis()
                    ? bySku
                    : null;
                const productId = input.productId ?? leftoverProduct?.id;

                // Lo que importa es si **esta** partida ya está en el servidor, no
                // si el lote existe: el mismo lote llega en otras facturas, y la
                // caja pide recapturar a mano lo que se atora. Se busca en esta
                // factura, desde la reserva.
                const applied = productId === undefined
                    ? { match: null, ambiguous: false }
                    : await findAppliedEntry({
                        invoiceId: input.invoiceId,
                        productId,
                        lotNumber: input.lotNumber,
                        quantity: input.quantity,
                        since: reservedAt,
                    });
                if (applied.ambiguous) {
                    throw entryAmbiguous();
                }
                if (applied.match) {
                    // Ya se aplicó (por este intento o recapturada a mano): se cierra
                    // la llave con esa entrada y se devuelve, sin sumar existencias.
                    await idempotencyRef.update(
                        { entryId: applied.match.id },
                        { lastUpdateTime: previo.updateTime! },
                    );
                    return replayEntry(applied.match.id);
                }
                // La precondición deja pasar a uno solo de dos reintentos simultáneos;
                // el otro ve una reserva que acaba de renovarse, es decir, en curso.
                await idempotencyRef.update(
                    { createdAt: new Date() },
                    { lastUpdateTime: previo.updateTime! },
                ).catch((error: unknown) => {
                    throw isFirestoreCode(error, FAILED_PRECONDITION) ? entryInProgress() : error;
                });
            } else {
                return replayEntry(entryId);
            }
        } else {
            // `create` falla si otro intento simultáneo ya la reservó: dos flushes en
            // paralelo no pueden aplicar la misma entrada dos veces.
            await idempotencyRef.create({ userId: input.userId, createdAt: new Date() })
                .catch((error: unknown) => {
                    throw isFirestoreCode(error, ALREADY_EXISTS) ? entryInProgress() : error;
                });
        }
    }

    const actor: AuditActor = { userId: input.userId, roleSlug: input.roleSlug ?? null };
    let product: Product;
    let entry: InventoryEntryWithDetails;
    try {
        product = input.productId
            ? await resolveExistingProduct(input.productId, input.productUpdate, actor)
            // `createProduct` recibe el actor dentro del mismo objeto de entrada.
            : leftoverProduct ?? await productsService.createProduct({ ...input.product!, actor });

        entry = await inventoryService.recordEntry({
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
        });
    } catch (error) {
        // Un rechazo de negocio no registró ninguna entrada: se libera la llave para
        // que el reintento diga el motivo real. Cualquier otro error (p. ej. un
        // timeout tras el commit) pudo haberla aplicado, así que la reserva se queda.
        if (idempotencyRef && error instanceof AppError && error.statusCode < 500) {
            await idempotencyRef.delete().catch(() => undefined);
        }
        throw error;
    }

    if (idempotencyRef) {
        // Cierra la llave en cuanto existe la entrada: de aquí en adelante el
        // reintento la devuelve en vez de crear otra.
        await idempotencyRef.set({ entryId: entry.id }, { merge: true });
    }

    // `recordEntry` ya incrementó `totalStock` dentro de su transacción; se relee
    // para devolver la cifra con la que la caja pinta "quedará en N".
    const stock = await productsService.getProduct(product.id);

    return { entry, product, stock: stock.stock };
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
 * Busca, en la factura y desde la reserva, una entrada con la misma partida
 * (producto, lote y cantidad). Si hay partidas de ese producto y lote pero con
 * otra cantidad, no se sabe si es esta corregida o una distinta: `ambiguous`.
 */
const findAppliedEntry = async (params: {
    invoiceId: string;
    productId: string;
    lotNumber: string;
    quantity: number;
    since: Timestamp;
}): Promise<{ match: InventoryEntry | null; ambiguous: boolean }> => {
    const lot = params.lotNumber.trim();
    const entries = (await entriesRepo.listInventoryEntries({ invoiceId: params.invoiceId }))
        .filter((entry) => entry.createdAt.toMillis() >= params.since.toMillis());
    const sameLot = entries.filter((entry) => entry.items.some(
        (item) => item.productId === params.productId && item.lotNumber === lot,
    ));
    const match = sameLot.find((entry) => entry.items.some(
        (item) => item.productId === params.productId &&
            item.lotNumber === lot &&
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
