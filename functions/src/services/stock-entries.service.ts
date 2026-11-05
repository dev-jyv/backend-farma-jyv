import { Timestamp } from 'firebase-admin/firestore';
import { ControlledGroup, InventoryEntryWithDetails, InvoiceWithDetails, Product } from '../types';
import { db } from '../utils/firestore';
import { AppError, conflict, notFound } from '../utils/errors';
import { AuditActor } from './audit.service';
import * as batchesRepo from '../repositories/batches.repository';
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

export const createStockEntry = async (input: {
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
                // Se reservó la llave y el intento no terminó. Solo se retoma si ya
                // no puede seguir en curso y ningún lote de ese número existe: con
                // la duda, duplicar existencias es peor que pedir que alguien revise.
                leftoverProduct = input.productId
                    ? null
                    : await productsRepo.findProductBySku(input.product!.sku);
                const productId = input.productId ?? leftoverProduct?.id;
                const createdAt = previo.data()?.createdAt as Timestamp | undefined;
                const isStale = createdAt !== undefined &&
                    Date.now() - createdAt.toMillis() > STALE_RESERVATION_MS;
                const lotExists = productId !== undefined && (
                    await batchesRepo.listBatchesByProduct(productId)
                ).some((batch) => batch.lotNumber === input.lotNumber.trim());
                if (!isStale || lotExists) {
                    throw conflict(
                        'Esta entrada quedó a medio registrar en un intento anterior. ' +
                            'Revisa el lote en inventario antes de volver a capturarla.',
                    );
                }
                // La precondición deja pasar a uno solo de dos reintentos simultáneos.
                await idempotencyRef.update(
                    { createdAt: new Date() },
                    { lastUpdateTime: previo.updateTime! },
                );
            } else {
                const replay = await inventoryService.getEntry(entryId);
                const producto = await productsService.getProduct(replay.items[0]!.productId);
                return {
                    entry: replay,
                    product: producto as unknown as Product,
                    stock: producto.stock,
                };
            }
        } else {
            // `create` falla si otro intento simultáneo ya la reservó: dos flushes en
            // paralelo no pueden aplicar la misma entrada dos veces.
            await idempotencyRef.create({ userId: input.userId, createdAt: new Date() });
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
    if (update && Object.keys(update).length > 0) {
        return productsService.updateProduct(productId, update, actor);
    }
    const product = await productsService.getProduct(productId);
    return product as unknown as Product & { controlledGroup?: ControlledGroup };
};
