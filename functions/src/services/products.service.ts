import {
    BulkCreateProductsResult,
    ControlledGroup,
    InvoiceSummary,
    Product,
    ProductDetail,
    ProductInvoiceHistoryItem,
    ProductPurchaseHistoryItem,
    ProductSaleHistoryItem,
    ProductWithCategory,
    Supplier,
    SupplierSummary,
} from '../types';
import { badRequest, notFound } from '../utils/errors';
import {
    buildListMeta,
    buildListResult,
    ListMeta,
    paginate,
    parsePagination,
} from '../utils/pagination';
import { matchesProductSearch } from '../utils/product-search';
import { getFileUrl } from '../utils/storage';
import { Timestamp } from 'firebase-admin/firestore';
import * as productsRepo from '../repositories/products.repository';
import * as categoriesRepo from '../repositories/categories.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';
import * as entriesRepo from '../repositories/inventory-entries.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import { AuditActor, diffFields, recordAudit } from './audit.service';

const loadSuppliersSummary = async (
    supplierIds: string[],
    lastCostPriceBySupplier: Record<string, number> = {},
): Promise<SupplierSummary[]> => {
    if (!supplierIds.length) {
        return [];
    }

    const suppliers = await suppliersRepo.getSuppliersByIds(supplierIds);
    return supplierIds
        .map((id) => suppliers.get(id))
        .filter((supplier): supplier is Supplier => Boolean(supplier))
        .map(({ id, name }) => ({
            id,
            name,
            ...(lastCostPriceBySupplier[id] !== undefined
                ? { lastCostPrice: lastCostPriceBySupplier[id] }
                : {}),
        }));
};

const loadInvoiceSummary = async (
    invoiceId: string,
    supplier: Pick<Supplier, 'id' | 'name'>,
    invoiceCache: Map<string, InvoiceSummary | null>,
): Promise<InvoiceSummary | null> => {
    let cached = invoiceCache.get(invoiceId);
    if (cached === undefined) {
        const invoiceDoc = await invoicesRepo.getInvoiceById(invoiceId);
        cached = invoiceDoc
            ? {
                id: invoiceDoc.id,
                invoiceNumber: invoiceDoc.invoiceNumber,
                invoiceDate: invoiceDoc.invoiceDate,
                supplier: { id: supplier.id, name: supplier.name },
            }
            : null;
        invoiceCache.set(invoiceId, cached);
    }
    return cached;
};

const loadPurchaseHistory = async (
    productId: string,
): Promise<ProductPurchaseHistoryItem[]> => {
    const entries = await entriesRepo.listInventoryEntries({ productId });
    const supplierCache = new Map<string, Supplier | null>();
    const invoiceCache = new Map<string, InvoiceSummary | null>();
    const history: ProductPurchaseHistoryItem[] = [];

    for (const entry of entries) {
        let supplier = supplierCache.get(entry.supplierId);
        if (supplier === undefined) {
            supplier = await suppliersRepo.getSupplierById(entry.supplierId);
            supplierCache.set(entry.supplierId, supplier);
        }
        if (!supplier) {
            throw notFound('Proveedor');
        }

        const supplierSummary = { id: supplier.id, name: supplier.name };
        const invoice = entry.invoiceId
            ? await loadInvoiceSummary(entry.invoiceId, supplierSummary, invoiceCache)
            : null;

        for (const item of entry.items) {
            if (item.productId !== productId) {
                continue;
            }
            history.push({
                entryId: entry.id,
                supplier: supplierSummary,
                invoice,
                lotNumber: item.lotNumber,
                expiryDate: item.expiryDate,
                quantity: item.quantity,
                ...(item.costPrice !== undefined ? { costPrice: item.costPrice } : {}),
                batchId: item.batchId,
                createdAt: entry.createdAt,
            });
        }
    }

    return history.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
};

const loadSalesHistory = async (productId: string): Promise<ProductSaleHistoryItem[]> => {
    const { items: sales } = await salesRepo.listSales({ productId });
    const history: ProductSaleHistoryItem[] = [];

    for (const sale of sales) {
        for (const item of sale.items) {
            if (item.productId !== productId) {
                continue;
            }
            history.push({
                saleId: sale.id,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                subtotal: item.subtotal,
                paymentMethod: sale.paymentMethod,
                createdAt: sale.createdAt,
            });
        }
    }

    return history.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
};

const loadInvoiceHistory = async (
    productId: string,
): Promise<ProductInvoiceHistoryItem[]> => {
    const entries = await entriesRepo.listInventoryEntries({ productId });
    const grouped = new Map<string, { quantityReceived: number; lastReceivedAt: number }>();

    for (const entry of entries) {
        if (!entry.invoiceId) {
            continue;
        }
        const productQuantity = entry.items
            .filter((item) => item.productId === productId)
            .reduce((sum, item) => sum + item.quantity, 0);
        const entryMs = entry.createdAt.toMillis();
        const existing = grouped.get(entry.invoiceId);

        if (existing) {
            existing.quantityReceived += productQuantity;
            existing.lastReceivedAt = Math.max(existing.lastReceivedAt, entryMs);
        } else {
            grouped.set(entry.invoiceId, {
                quantityReceived: productQuantity,
                lastReceivedAt: entryMs,
            });
        }
    }

    const supplierCache = new Map<string, Supplier | null>();
    const history = await Promise.all(
        [...grouped.entries()].map(async ([invoiceId, aggregate]) => {
            const invoice = await invoicesRepo.getInvoiceById(invoiceId);
            if (!invoice) {
                return null;
            }

            let supplier = supplierCache.get(invoice.supplierId);
            if (supplier === undefined) {
                supplier = await suppliersRepo.getSupplierById(invoice.supplierId);
                supplierCache.set(invoice.supplierId, supplier);
            }
            if (!supplier) {
                throw notFound('Proveedor');
            }

            const fileUrl = invoice.storagePath
                ? await getFileUrl(invoice.storagePath)
                : undefined;

            return {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                invoiceDate: invoice.invoiceDate,
                totalAmount: invoice.totalAmount,
                hasInvoice: invoice.hasInvoice,
                ...(fileUrl ? { fileUrl } : {}),
                supplier: { id: supplier.id, name: supplier.name },
                quantityReceived: aggregate.quantityReceived,
                lastReceivedAt: Timestamp.fromMillis(aggregate.lastReceivedAt),
            };
        }),
    );

    return history
        .filter((item): item is ProductInvoiceHistoryItem => item !== null)
        .sort((a, b) => b.invoiceDate.toMillis() - a.invoiceDate.toMillis());
};

export const listProducts = async (filters: {
    categoryId?: string;
    search?: string;
    activeOnly?: boolean;
    page?: number;
    limit?: number;
}): Promise<{
    items: Array<ProductWithCategory & { stock: number }>;
    meta: ListMeta;
}> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const search = filters.search?.trim();
    let items: Product[];

    if (search) {
        const exact = await productsRepo.findProductBySkuOrBarcode(search);
        if (exact) {
            items = [exact];
        } else if (filters.categoryId) {
            items = await productsRepo.listProducts({
                categoryId: filters.categoryId,
                activeOnly: filters.activeOnly,
            });
            items = items.filter((product) => matchesProductSearch(product, search));
        } else {
            items = await productsRepo.listProducts({
                activeOnly: filters.activeOnly,
                limit: 500,
            });
            items = items.filter((product) => matchesProductSearch(product, search));
        }
    } else {
        items = await productsRepo.listProducts({
            categoryId: filters.categoryId,
            activeOnly: filters.activeOnly,
        });
    }

    const { items: paginated, total } = paginate(items, page, limit);
    const categoryIds = [...new Set(paginated.map((product) => product.categoryId))];
    const categories = await categoriesRepo.getCategoriesByIds(categoryIds);

    const withDetails = await Promise.all(
        paginated.map(async (product) => {
            const category = categories.get(product.categoryId);
            if (!category) {
                throw notFound('Categoría');
            }
            const stock = product.totalStock ?? await batchesRepo.getTotalStock(product.id);
            return {
                ...product,
                stock,
                category,
            };
        }),
    );

    return {
        items: withDetails,
        meta: buildListMeta(page, limit, total),
    };
};

const ensureProductExists = async (id: string): Promise<void> => {
    const product = await productsRepo.getProductById(id);
    if (!product) {
        throw notFound('Producto');
    }
};

export const getProduct = async (id: string): Promise<ProductDetail> => {
    const product = await productsRepo.getProductById(id);
    if (!product) {
        throw notFound('Producto');
    }

    const [stock, suppliers, category] = await Promise.all([
        product.totalStock !== undefined
            ? Promise.resolve(product.totalStock)
            : batchesRepo.getTotalStock(id),
        loadSuppliersSummary(product.suppliers ?? [], product.lastCostPriceBySupplier ?? {}),
        categoriesRepo.getCategoryById(product.categoryId),
    ]);

    if (!category) {
        throw notFound('Categoría');
    }

    const { lastCostPriceBySupplier: _, ...productData } = product;
    return {
        ...productData,
        stock,
        suppliers,
        category,
    };
};

export const getProductPurchaseHistory = async (
    id: string,
    filters: { search?: string; page?: number; limit?: number },
): Promise<{ items: ProductPurchaseHistoryItem[]; meta: ListMeta }> => {
    await ensureProductExists(id);
    const { page, limit } = parsePagination(filters.page, filters.limit);
    let history = await loadPurchaseHistory(id);

    if (filters.search) {
        const term = filters.search.toLowerCase();
        history = history.filter(
            (item) =>
                item.supplier.name.toLowerCase().includes(term) ||
                (item.invoice?.invoiceNumber.toLowerCase().includes(term) ?? false) ||
                item.lotNumber.toLowerCase().includes(term) ||
                item.entryId.toLowerCase().includes(term) ||
                item.batchId.toLowerCase().includes(term),
        );
    }

    return buildListResult(history, page, limit);
};

export const getProductSalesHistory = async (
    id: string,
    filters: { search?: string; page?: number; limit?: number },
): Promise<{ items: ProductSaleHistoryItem[]; meta: ListMeta }> => {
    await ensureProductExists(id);
    const { page, limit } = parsePagination(filters.page, filters.limit);
    let history = await loadSalesHistory(id);

    if (filters.search) {
        const term = filters.search.toLowerCase();
        history = history.filter(
            (item) =>
                item.saleId.toLowerCase().includes(term) ||
                item.paymentMethod.toLowerCase().includes(term),
        );
    }

    return buildListResult(history, page, limit);
};

export const getProductInvoiceHistory = async (
    id: string,
    filters: { search?: string; page?: number; limit?: number },
): Promise<{ items: ProductInvoiceHistoryItem[]; meta: ListMeta }> => {
    await ensureProductExists(id);
    const { page, limit } = parsePagination(filters.page, filters.limit);
    let history = await loadInvoiceHistory(id);

    if (filters.search) {
        const term = filters.search.toLowerCase();
        history = history.filter(
            (item) =>
                item.invoiceNumber.toLowerCase().includes(term) ||
                item.supplier.name.toLowerCase().includes(term),
        );
    }

    return buildListResult(history, page, limit);
};

/** Campos de producto que se vigilan en la bitácora (precio, impuestos, control). */
const AUDITED_PRODUCT_FIELDS: Array<keyof Product> = [
    'name',
    'sku',
    'barcode',
    'salePrice',
    'minStock',
    'hasIva',
    'hasIvaZero',
    'hasIeps',
    'iepsRate',
    'controlledGroup',
    'requiresPrescription',
    'isActive',
];

const auditProductUpdate = async (
    before: Product,
    after: Product,
    actor?: AuditActor,
): Promise<void> => {
    const changes = diffFields(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        AUDITED_PRODUCT_FIELDS as unknown as string[],
    );
    if (!changes) {
        return;
    }

    const priceChanged = Boolean(changes.salePrice);
    await recordAudit({
        action: priceChanged ? 'product.price_changed' : 'product.updated',
        entity: 'product',
        entityId: after.id,
        summary: priceChanged
            ? `Precio de ${after.name} de ${before.salePrice.toFixed(2)} a ` +
                `${after.salePrice.toFixed(2)}`
            : `Producto ${after.name} actualizado (${Object.keys(changes).join(', ')})`,
        userId: actor?.userId ?? 'system',
        roleSlug: actor?.roleSlug ?? null,
        changes,
    });
};

export const createProduct = async (input: {
    name: string;
    sku: string;
    barcode?: string;
    activeIngredient?: string;
    categoryId: string;
    unit: string;
    salePrice: number;
    minStock: number;
    hasIva: boolean;
    hasIvaZero: boolean;
    hasIeps: boolean;
    concentration?: string;
    controlledGroup?: ControlledGroup;
    iepsRate?: number;
    requiresPrescription?: boolean;
    /** Actor para la bitácora; opcional para no romper llamadas internas. */
    actor?: AuditActor;
}): Promise<Product> => {
    const name = input.name.trim();
    const sku = input.sku.trim();
    const barcode = input.barcode?.trim();

    if (!name || !sku) {
        throw badRequest('Nombre y SKU son requeridos');
    }

    if (input.salePrice < 0 || input.minStock < 0) {
        throw badRequest('Precio y stock mínimo deben ser positivos');
    }

    const category = await categoriesRepo.getCategoryById(input.categoryId);
    if (!category || !category.isActive) {
        throw notFound('Categoría');
    }

    const created = await productsRepo.createProduct({
        name,
        sku,
        barcode,
        activeIngredient: input.activeIngredient?.trim(),
        categoryId: input.categoryId,
        unit: input.unit.trim(),
        salePrice: input.salePrice,
        minStock: input.minStock,
        totalStock: 0,
        hasIva: input.hasIva,
        hasIvaZero: input.hasIvaZero,
        hasIeps: input.hasIeps,
        concentration: input.concentration?.trim(),
        controlledGroup: input.controlledGroup,
        iepsRate: input.iepsRate,
        requiresPrescription: input.requiresPrescription ?? false,
        isActive: true,
        suppliers: [],
    });

    await recordAudit({
        action: 'product.created',
        entity: 'product',
        entityId: created.id,
        summary: `Producto ${created.name} (${created.sku}) creado a ` +
            `${created.salePrice.toFixed(2)}`,
        userId: input.actor?.userId ?? 'system',
        roleSlug: input.actor?.roleSlug ?? null,
    });

    return created;
};

type CreateProductInput = {
    name: string;
    sku: string;
    barcode?: string;
    activeIngredient?: string;
    categoryId: string;
    unit: string;
    salePrice: number;
    minStock: number;
    hasIva: boolean;
    hasIvaZero: boolean;
    hasIeps: boolean;
    concentration?: string;
    requiresPrescription?: boolean;
};

export const bulkCreateProducts = async (
    items: CreateProductInput[],
): Promise<BulkCreateProductsResult> => {
    const created: Product[] = [];
    const errors: BulkCreateProductsResult['errors'] = [];

    const seen: { name: Set<string>; sku: Set<string>; barcode: Set<string> } = {
        name: new Set(),
        sku: new Set(),
        barcode: new Set(),
    };

    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const name = item.name.trim().toLowerCase();
        const sku = item.sku.trim().toLowerCase();
        const barcode = item.barcode?.trim().toLowerCase();

        if (seen.name.has(name) || seen.sku.has(sku) || (barcode && seen.barcode.has(barcode))) {
            errors.push({
                index,
                sku: item.sku,
                message: 'Duplicado en el archivo (nombre, SKU o código de barras repetido)',
            });
            continue;
        }

        try {
            const product = await createProduct(item);
            seen.name.add(name);
            seen.sku.add(sku);
            if (barcode) {
                seen.barcode.add(barcode);
            }
            created.push(product);
        } catch (error) {
            errors.push({
                index,
                sku: item.sku,
                message: error instanceof Error ? error.message : 'No se pudo crear el producto',
            });
        }
    }

    return { created, errors };
};

export const updateProduct = async (
    id: string,
    input: Partial<{
        name: string;
        sku: string;
        barcode: string;
        activeIngredient: string;
        categoryId: string;
        unit: string;
        salePrice: number;
        minStock: number;
        hasIva: boolean;
        hasIvaZero: boolean;
        hasIeps: boolean;
        concentration: string;
        controlledGroup: ControlledGroup;
        iepsRate: number;
        requiresPrescription: boolean;
        isActive: boolean;
    }>,
    actor?: AuditActor,
): Promise<Product> => {
    const existing = await productsRepo.getProductById(id);
    if (!existing) {
        throw notFound('Producto');
    }

    const hasIva = input.hasIva ?? existing.hasIva;
    const hasIvaZero = input.hasIvaZero ?? existing.hasIvaZero;
    if (hasIva && hasIvaZero) {
        throw badRequest('Un producto no puede tener IVA e IVA cero al mismo tiempo');
    }

    if (input.categoryId) {
        const category = await categoriesRepo.getCategoryById(input.categoryId);
        if (!category || !category.isActive) {
            throw notFound('Categoría');
        }
    }

    const name = input.name?.trim();
    const sku = input.sku?.trim();
    const barcode = input.barcode?.trim();

    const updated = await productsRepo.updateProduct(id, {
        name,
        sku,
        barcode,
        activeIngredient: input.activeIngredient?.trim(),
        categoryId: input.categoryId,
        unit: input.unit?.trim(),
        salePrice: input.salePrice,
        minStock: input.minStock,
        hasIva: input.hasIva,
        hasIvaZero: input.hasIvaZero,
        hasIeps: input.hasIeps,
        concentration: input.concentration?.trim(),
        controlledGroup: input.controlledGroup,
        iepsRate: input.iepsRate,
        requiresPrescription: input.requiresPrescription,
        isActive: input.isActive,
    });

    await auditProductUpdate(existing, updated, actor);
    return updated;
};

export const updateProductPrices = async (
    items: Array<{ productId: string; salePrice: number }>,
    actor?: AuditActor,
): Promise<Product[]> => {
    const uniqueIds = [...new Set(items.map((item) => item.productId))];
    if (uniqueIds.length !== items.length) {
        throw badRequest('No se permiten productos duplicados');
    }

    const products = await Promise.all(
        uniqueIds.map((productId) => productsRepo.getProductById(productId)),
    );

    for (let index = 0; index < uniqueIds.length; index++) {
        if (!products[index]) {
            throw notFound(`Producto ${uniqueIds[index]}`);
        }
    }

    const existingById = new Map(
        (products as Product[]).map((product) => [product.id, product]),
    );

    const updated = await Promise.all(
        items.map((item) =>
            productsRepo.updateProduct(item.productId, { salePrice: item.salePrice })),
    );

    // Cambio masivo de precios: una bitácora por producto que realmente cambió.
    await Promise.all(updated.map((product) => {
        const before = existingById.get(product.id);
        if (!before || before.salePrice === product.salePrice) {
            return Promise.resolve();
        }
        return recordAudit({
            action: 'product.price_changed',
            entity: 'product',
            entityId: product.id,
            summary: `Precio de ${product.name} de ${before.salePrice.toFixed(2)} a ` +
                `${product.salePrice.toFixed(2)} (actualización masiva)`,
            userId: actor?.userId ?? 'system',
            roleSlug: actor?.roleSlug ?? null,
            changes: { salePrice: { before: before.salePrice, after: product.salePrice } },
        });
    }));

    return updated;
};

export const deleteProduct = async (id: string, actor?: AuditActor): Promise<Product> => {
    const existing = await productsRepo.getProductById(id);
    if (!existing) {
        throw notFound('Producto');
    }

    const updated = await productsRepo.updateProduct(id, { isActive: false });
    await recordAudit({
        action: 'product.deactivated',
        entity: 'product',
        entityId: id,
        summary: `Producto ${existing.name} (${existing.sku}) dado de baja`,
        userId: actor?.userId ?? 'system',
        roleSlug: actor?.roleSlug ?? null,
    });
    return updated;
};
