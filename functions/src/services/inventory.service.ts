import { FieldValue } from 'firebase-admin/firestore';
import { Batch, BatchWithDetails, ExitReason, InventoryEntry, InventoryEntryItem, InventoryEntryWithDetails, Product, ProductWithCategory, StockMovement, Supplier } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { db, now, toTimestamp } from '../utils/firestore';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as movementsRepo from '../repositories/stock-movements.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';
import * as entriesRepo from '../repositories/inventory-entries.repository';
import * as categoriesRepo from '../repositories/categories.repository';

export const listBatches = async (
    productId: string,
    filters: { search?: string; page?: number; limit?: number } = {},
): Promise<{ items: BatchWithDetails[]; meta: ListMeta }> => {
    const product = await productsRepo.getProductById(productId);
    if (!product) {
        throw notFound('Producto');
    }

    const { page, limit } = parsePagination(filters.page, filters.limit);
    const productWithCategory = await loadProductWithCategory(product);
    const batches = await batchesRepo.listBatchesByProduct(productId);
    const entrySupplierCache = new Map<string, Supplier | null>();

    let items = await Promise.all(
        batches.map(async (batch) => {
            const referenceId = await movementsRepo.findEntryReferenceByBatchId(batch.id);
            let supplier: Supplier | null = null;

            if (referenceId) {
                if (!entrySupplierCache.has(referenceId)) {
                    const entry = await entriesRepo.getInventoryEntryById(referenceId);
                    if (entry?.supplierId) {
                        entrySupplierCache.set(
                            referenceId,
                            await suppliersRepo.getSupplierById(entry.supplierId),
                        );
                    } else {
                        entrySupplierCache.set(referenceId, null);
                    }
                }
                supplier = entrySupplierCache.get(referenceId) ?? null;
            }

            return { ...batch, product: productWithCategory, supplier };
        }),
    );

    if (filters.search) {
        const term = filters.search.toLowerCase();
        items = items.filter(
            (batch) =>
                batch.lotNumber.toLowerCase().includes(term) ||
                batch.product.name.toLowerCase().includes(term) ||
                (batch.supplier?.name.toLowerCase().includes(term) ?? false),
        );
    }

    const paginated = paginate(items, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

type EntryItemInput = {
    productId: string;
    lotNumber?: string;
    expiryDate: string;
    quantity: number;
    costPrice?: number;
};

const normalizeExpiryDate = (expiryDate: string): string =>
    new Date(expiryDate).toISOString().slice(0, 10);

const defaultLotNumber = (productId: string, expiryDate: string) =>
    `${productId.slice(0, 8)}-${expiryDate.replace(/\D/g, '').slice(0, 8)}`;

const batchKey = (productId: string, lotNumber: string, expiryDate: string) =>
    `${productId}::${lotNumber}::${normalizeExpiryDate(expiryDate)}`;

const productLotKey = (productId: string, lotNumber: string) =>
    `${productId}::${lotNumber}`;

const loadProductWithCategory = async (product: Product): Promise<ProductWithCategory> => {
    const category = await categoriesRepo.getCategoryById(product.categoryId);
    if (!category) {
        throw notFound('Categoría');
    }
    return { ...product, category };
};

const enrichEntry = async (
    entry: InventoryEntry,
    supplierCache = new Map<string, Supplier | null>(),
    productCache = new Map<string, ProductWithCategory | null>(),
): Promise<InventoryEntryWithDetails> => {
    let supplier = supplierCache.get(entry.supplierId);
    if (supplier === undefined) {
        supplier = await suppliersRepo.getSupplierById(entry.supplierId);
        supplierCache.set(entry.supplierId, supplier);
    }
    if (!supplier) {
        throw notFound('Proveedor');
    }

    const items = await Promise.all(
        entry.items.map(async (item) => {
            let product = productCache.get(item.productId);
            if (product === undefined) {
                const baseProduct = await productsRepo.getProductById(item.productId);
                product = baseProduct ? await loadProductWithCategory(baseProduct) : null;
                productCache.set(item.productId, product);
            }
            if (!product) {
                throw notFound('Producto');
            }
            return { ...item, product };
        }),
    );

    return { ...entry, supplier, items };
};

export const listEntries = async (filters: {
    supplierId?: string;
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: InventoryEntryWithDetails[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const entries = await entriesRepo.listInventoryEntries(filters);
    const supplierCache = new Map<string, Supplier | null>();
    const productCache = new Map<string, ProductWithCategory | null>();
    let items = await Promise.all(
        entries.map((entry) => enrichEntry(entry, supplierCache, productCache)),
    );

    if (filters.search) {
        const term = filters.search.toLowerCase();
        items = items.filter(
            (entry) =>
                entry.supplier.name.toLowerCase().includes(term) ||
                entry.items.some((item) => item.product.name.toLowerCase().includes(term)),
        );
    }

    const paginated = paginate(items, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

export const getEntry = async (id: string): Promise<InventoryEntryWithDetails> => {
    const entry = await entriesRepo.getInventoryEntryById(id);
    if (!entry) {
        throw notFound('Entrada de inventario');
    }
    return enrichEntry(entry);
};

export const recordEntry = async (input: {
    supplierId: string;
    items: EntryItemInput[];
    userId: string;
}): Promise<InventoryEntryWithDetails> => {
    if (!input.items.length) {
        throw badRequest('Debe incluir al menos un producto');
    }

    const supplier = await suppliersRepo.getSupplierById(input.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }
    if (!supplier.isActive) {
        throw badRequest('El proveedor no está activo');
    }

    type CachedProduct = Awaited<ReturnType<typeof productsRepo.getProductById>>;
    const productCache = new Map<string, CachedProduct>();
    const normalizedItems = input.items.map((item) => {
        const expiry = new Date(item.expiryDate);
        if (Number.isNaN(expiry.getTime())) {
            throw badRequest('Fecha de caducidad inválida');
        }

        const expiryDate = normalizeExpiryDate(item.expiryDate);
        return {
            ...item,
            expiryDate,
            lotNumber: item.lotNumber?.trim() || defaultLotNumber(item.productId, expiryDate),
        };
    });

    const expiryByProductLot = new Map<string, string>();

    for (const item of normalizedItems) {
        if (item.quantity <= 0) {
            throw badRequest('La cantidad debe ser mayor a cero');
        }

        const lotKey = productLotKey(item.productId, item.lotNumber);
        const existingExpiry = expiryByProductLot.get(lotKey);
        if (existingExpiry && existingExpiry !== item.expiryDate) {
            throw badRequest(
                `El lote ${item.lotNumber} ya tiene otra fecha de caducidad en esta entrada`,
            );
        }
        expiryByProductLot.set(lotKey, item.expiryDate);

        let product = productCache.get(item.productId);
        if (!product) {
            product = await productsRepo.getProductById(item.productId);
            productCache.set(item.productId, product);
        }

        if (!product || !product.isActive) {
            throw notFound(`Producto ${item.productId}`);
        }
    }

    const firestore = db();
    const entryRef = firestore.collection('inventoryEntries').doc();
    const timestamp = now();
    type BatchLookup = { productId: string; lotNumber: string; expiryDate: string };
    const uniqueBatches = new Map<string, BatchLookup>();

    for (const item of normalizedItems) {
        const key = batchKey(item.productId, item.lotNumber, item.expiryDate);
        uniqueBatches.set(key, {
            productId: item.productId,
            lotNumber: item.lotNumber,
            expiryDate: item.expiryDate,
        });
    }

    const existingBatches = new Map<string, Batch | null>();
    for (const [key, { productId, lotNumber, expiryDate }] of uniqueBatches) {
        existingBatches.set(
            key,
            await batchesRepo.findBatchByProductLotAndExpiry(productId, lotNumber, expiryDate),
        );
    }

    const entry = await firestore.runTransaction(async (transaction) => {
        const batchState = new Map<string, Batch>();
        const entryItems: InventoryEntryItem[] = [];

        for (const [key, existingBatch] of existingBatches) {
            if (!existingBatch) {
                continue;
            }

            const batchDoc = await transaction.get(
                firestore.collection('batches').doc(existingBatch.id),
            );

            if (!batchDoc.exists) {
                throw notFound('Lote');
            }

            batchState.set(key, { id: batchDoc.id, ...batchDoc.data() } as Batch);
        }

        for (const item of normalizedItems) {
            const key = batchKey(item.productId, item.lotNumber, item.expiryDate);
            const existingBatch = batchState.get(key);
            const movementRef = firestore.collection('stockMovements').doc();
            let batch: Batch;

            if (existingBatch) {
                const batchRef = firestore.collection('batches').doc(existingBatch.id);
                const newQuantity = existingBatch.quantity + item.quantity;
                batch = {
                    ...existingBatch,
                    quantity: newQuantity,
                    costPrice: item.costPrice ?? existingBatch.costPrice,
                    updatedAt: timestamp,
                };
                transaction.update(batchRef, {
                    quantity: newQuantity,
                    costPrice: batch.costPrice,
                    updatedAt: timestamp,
                });
            } else {
                const batchRef = firestore.collection('batches').doc();
                const batchData = {
                    productId: item.productId,
                    lotNumber: item.lotNumber,
                    expiryDate: toTimestamp(item.expiryDate),
                    quantity: item.quantity,
                    costPrice: item.costPrice,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                transaction.set(batchRef, batchData);
                batch = { id: batchRef.id, ...batchData };
            }

            batchState.set(key, batch);

            const movementData = {
                type: 'entry' as const,
                productId: item.productId,
                batchId: batch.id,
                quantity: item.quantity,
                referenceId: entryRef.id,
                userId: input.userId,
                createdAt: timestamp,
            };
            transaction.set(movementRef, movementData);

            entryItems.push({
                productId: item.productId,
                lotNumber: item.lotNumber,
                expiryDate: toTimestamp(item.expiryDate),
                quantity: item.quantity,
                costPrice: item.costPrice,
                batchId: batch.id,
            });
        }

        const entryData = {
            supplierId: input.supplierId,
            items: entryItems,
            createdAt: timestamp,
            createdBy: input.userId,
            updatedAt: timestamp,
            updatedBy: input.userId,
        };
        transaction.set(entryRef, entryData);

        const lastCostByProduct = new Map<string, number>();
        for (const item of normalizedItems) {
            if (item.costPrice !== undefined) {
                lastCostByProduct.set(item.productId, item.costPrice);
            }
        }

        const uniqueProductIds = [...new Set(normalizedItems.map((item) => item.productId))];
        for (const productId of uniqueProductIds) {
            const lastCostPrice = lastCostByProduct.get(productId);
            transaction.update(firestore.collection('products').doc(productId), {
                suppliers: FieldValue.arrayUnion(input.supplierId),
                updatedAt: timestamp,
                ...(lastCostPrice !== undefined
                    ? { [`lastCostPriceBySupplier.${input.supplierId}`]: lastCostPrice }
                    : {}),
            });
        }

        return { id: entryRef.id, ...entryData };
    });

    return enrichEntry(entry);
};

export const recordExit = async (input: {
    productId: string;
    batchId: string;
    quantity: number;
    reason: ExitReason;
    notes?: string;
    userId: string;
}): Promise<{ batch: Batch; movement: StockMovement }> => {
    if (input.quantity <= 0) {
        throw badRequest('La cantidad debe ser mayor a cero');
    }

    const product = await productsRepo.getProductById(input.productId);
    if (!product) {
        throw notFound('Producto');
    }

    const batch = await batchesRepo.getBatchById(input.batchId);
    if (!batch || batch.productId !== input.productId) {
        throw notFound('Lote');
    }

    if (batch.quantity < input.quantity) {
        throw badRequest('Cantidad superior al stock del lote');
    }

    const movementType = input.reason === 'waste' ? 'exit_waste' : 'exit_expiry';
    const firestore = db();
    const batchRef = firestore.collection('batches').doc(batch.id);
    const movementRef = firestore.collection('stockMovements').doc();
    const timestamp = now();
    const newQuantity = batch.quantity - input.quantity;

    const result = await firestore.runTransaction(async (transaction) => {
        transaction.update(batchRef, {
            quantity: newQuantity,
            updatedAt: timestamp,
        });

        const movementData: Omit<StockMovement, 'id'> = {
            type: movementType,
            productId: input.productId,
            batchId: batch.id,
            quantity: input.quantity,
            reason: input.notes?.trim() ?? input.reason,
            userId: input.userId,
            createdAt: timestamp,
        };
        transaction.set(movementRef, movementData);

        return {
            batch: { ...batch, quantity: newQuantity, updatedAt: timestamp },
            movement: { id: movementRef.id, ...movementData },
        };
    });

    return result;
};

export const listMovements = async (filters: {
    productId?: string;
    type?: StockMovement['type'];
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: StockMovement[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await movementsRepo.listStockMovements({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};
