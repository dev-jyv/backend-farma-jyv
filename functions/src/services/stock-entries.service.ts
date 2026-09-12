import { ControlledGroup, InventoryEntryWithDetails, InvoiceWithDetails, Product } from '../types';
import { db } from '../utils/firestore';
import { conflict, notFound } from '../utils/errors';
import { AuditActor } from './audit.service';
import * as invoicesRepo from '../repositories/invoices.repository';
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

    if (idempotencyRef) {
        const previo = await idempotencyRef.get();
        if (previo.exists) {
            const entryId = previo.data()?.entryId as string | undefined;
            if (!entryId) {
                // Se reservó la llave y el proceso murió antes de terminar. No se
                // reintenta solo: la entrada pudo quedar aplicada a medias y
                // duplicarla es peor que pedir que alguien la revise.
                throw conflict(
                    'Esta entrada quedó a medio registrar en un intento anterior. ' +
                        'Revisa el lote en inventario antes de volver a capturarla.',
                );
            }
            const replay = await inventoryService.getEntry(entryId);
            const producto = await productsService.getProduct(replay.items[0]!.productId);
            return { entry: replay, product: producto as unknown as Product, stock: producto.stock };
        }
        // `create` falla si otro intento simultáneo ya la reservó: dos flushes en
        // paralelo no pueden aplicar la misma entrada dos veces.
        await idempotencyRef.create({ userId: input.userId, createdAt: new Date() });
    }

    const actor: AuditActor = { userId: input.userId, roleSlug: input.roleSlug ?? null };
    const product = input.productId
        ? await resolveExistingProduct(input.productId, input.productUpdate, actor)
        // `createProduct` recibe el actor dentro del mismo objeto de entrada.
        : await productsService.createProduct({ ...input.product!, actor });

    const entry = await inventoryService.recordEntry({
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

    // `recordEntry` ya incrementó `totalStock` dentro de su transacción; se relee
    // para devolver la cifra con la que la caja pinta "quedará en N".
    const stock = await productsService.getProduct(product.id);

    if (idempotencyRef) {
        // Cierra la llave: de aquí en adelante el reintento devuelve esta entrada
        // en vez de crear otra.
        await idempotencyRef.set({ entryId: entry.id }, { merge: true });
    }

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
