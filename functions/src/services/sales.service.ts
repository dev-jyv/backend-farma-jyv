import { PaymentMethod, Sale, SaleItem } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { matchesProductSearch } from '../utils/product-search';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { allocateFefo } from '../utils/fefo';
import { db, now } from '../utils/firestore';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as salesRepo from '../repositories/sales.repository';

interface SaleItemInput {
    productId: string;
    quantity: number;
}

export const createSale = async (input: {
    items: SaleItemInput[];
    paymentMethod: PaymentMethod;
    cashierId: string;
}): Promise<Sale> => {
    if (!input.items.length) {
        throw badRequest('La venta debe tener al menos un producto');
    }

    const firestore = db();
    const saleRef = firestore.collection('sales').doc();
    const timestamp = now();

    const saleItems: SaleItem[] = [];
    let subtotal = 0;

    type CachedProduct = Awaited<ReturnType<typeof productsRepo.getProductById>>;
    type CachedBatches = Awaited<ReturnType<typeof batchesRepo.listBatchesByProduct>>;

    const productCache = new Map<string, CachedProduct>();
    const batchCache = new Map<string, CachedBatches>();

    for (const item of input.items) {
        if (item.quantity <= 0) {
            throw badRequest('Cantidad inválida en un ítem de venta');
        }

        let product = productCache.get(item.productId);
        if (!product) {
            product = await productsRepo.getProductById(item.productId);
            productCache.set(item.productId, product);
        }

        if (!product || !product.isActive) {
            throw notFound(`Producto ${item.productId}`);
        }

        let batches = batchCache.get(item.productId);
        if (!batches) {
            batches = await batchesRepo.listBatchesByProduct(item.productId);
            batchCache.set(item.productId, batches);
        }

        let allocations;
        try {
            allocations = allocateFefo(batches, item.quantity);
        } catch {
            throw badRequest(`Stock insuficiente para ${product.name}`);
        }
        const itemSubtotal = product.salePrice * item.quantity;
        subtotal += itemSubtotal;

        saleItems.push({
            productId: product.id,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: product.salePrice,
            subtotal: itemSubtotal,
            batchAllocations: allocations,
        });
    }

    const sale = await firestore.runTransaction(async (transaction) => {
        for (const item of saleItems) {
            for (const allocation of item.batchAllocations) {
                const batchRef = firestore.collection('batches').doc(allocation.batchId);
                const batchDoc = await transaction.get(batchRef);

                if (!batchDoc.exists) {
                    throw notFound('Lote');
                }

                const currentQty = batchDoc.data()?.quantity as number;
                if (currentQty < allocation.quantity) {
                    throw badRequest(`Stock insuficiente en lote ${allocation.batchId}`);
                }

                transaction.update(batchRef, {
                    quantity: currentQty - allocation.quantity,
                    updatedAt: timestamp,
                });

                const movementRef = firestore.collection('stockMovements').doc();
                transaction.set(movementRef, {
                    type: 'sale_adjustment',
                    productId: item.productId,
                    batchId: allocation.batchId,
                    quantity: allocation.quantity,
                    referenceId: saleRef.id,
                    userId: input.cashierId,
                    createdAt: timestamp,
                });
            }
        }

        const saleData = {
            items: saleItems,
            subtotal,
            total: subtotal,
            paymentMethod: input.paymentMethod,
            cashierId: input.cashierId,
            createdAt: timestamp,
        };

        transaction.set(saleRef, saleData);
        return { id: saleRef.id, ...saleData };
    });

    return sale;
};

export const getSale = async (id: string): Promise<Sale> => {
    const sale = await salesRepo.getSaleById(id);
    if (!sale) {
        throw notFound('Venta');
    }
    return sale;
};

export const listSales = async (filters: {
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Sale[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items: sales } = await salesRepo.listSales({
        from: filters.from,
        to: filters.to,
    });

    let filtered = sales;

    if (filters.search) {
        const term = filters.search.toLowerCase();
        const productIds = [
            ...new Set(filtered.flatMap((sale) => sale.items.map((item) => item.productId))),
        ];
        const productCache = new Map<
            string,
            Awaited<ReturnType<typeof productsRepo.getProductById>>
        >();
        await Promise.all(
            productIds.map(async (id) => {
                productCache.set(id, await productsRepo.getProductById(id));
            }),
        );

        filtered = filtered.filter((sale) =>
            sale.items.some((item) => {
                const product = productCache.get(item.productId);
                return (
                    (product && matchesProductSearch(product, term)) ||
                    item.productName.toLowerCase().includes(term)
                );
            }),
        );
    }

    const paginated = paginate(filtered, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};
