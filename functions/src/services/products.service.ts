import {
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
import { badRequest, conflict, notFound } from '../utils/errors';
import { buildListMeta, buildListResult, ListMeta, parsePagination } from '../utils/pagination';
import { getFileUrl } from '../utils/storage';
import { Timestamp } from 'firebase-admin/firestore';
import * as productsRepo from '../repositories/products.repository';
import * as categoriesRepo from '../repositories/categories.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';
import * as entriesRepo from '../repositories/inventory-entries.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as invoicesRepo from '../repositories/invoices.repository';

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
    const { items, total } = await productsRepo.listProducts({ ...filters, page, limit });
    const categoryIds = [...new Set(items.map((product) => product.categoryId))];
    const [categories, stockValues] = await Promise.all([
        categoriesRepo.getCategoriesByIds(categoryIds),
        Promise.all(items.map((product) => batchesRepo.getTotalStock(product.id))),
    ]);

    const withDetails = items.map((product, index) => {
        const category = categories.get(product.categoryId);
        if (!category) {
            throw notFound('Categoría');
        }

        return {
            ...product,
            stock: stockValues[index],
            category,
        };
    });

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
        batchesRepo.getTotalStock(id),
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

export const createProduct = async (input: {
    name: string;
    sku: string;
    barcode?: string;
    activeIngredient?: string;
    categoryId: string;
    unit: string;
    salePrice: number;
    minStock: number;
}): Promise<Product> => {
    if (!input.name.trim() || !input.sku.trim()) {
        throw badRequest('Nombre y SKU son requeridos');
    }

    if (input.salePrice < 0 || input.minStock < 0) {
        throw badRequest('Precio y stock mínimo deben ser positivos');
    }

    const category = await categoriesRepo.getCategoryById(input.categoryId);
    if (!category || !category.isActive) {
        throw notFound('Categoría');
    }

    const existingSku = await productsRepo.getProductBySku(input.sku.trim());
    if (existingSku) {
        throw conflict('Ya existe un producto con ese SKU');
    }

    return productsRepo.createProduct({
        name: input.name.trim(),
        sku: input.sku.trim(),
        barcode: input.barcode?.trim(),
        activeIngredient: input.activeIngredient?.trim(),
        categoryId: input.categoryId,
        unit: input.unit.trim(),
        salePrice: input.salePrice,
        minStock: input.minStock,
        isActive: true,
        suppliers: [],
    });
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
        isActive: boolean;
    }>,
): Promise<Product> => {
    const existing = await productsRepo.getProductById(id);
    if (!existing) {
        throw notFound('Producto');
    }

    if (input.categoryId) {
        const category = await categoriesRepo.getCategoryById(input.categoryId);
        if (!category || !category.isActive) {
            throw notFound('Categoría');
        }
    }

    if (input.sku && input.sku !== existing.sku) {
        const duplicate = await productsRepo.getProductBySku(input.sku.trim());
        if (duplicate && duplicate.id !== id) {
            throw conflict('Ya existe un producto con ese SKU');
        }
    }

    return productsRepo.updateProduct(id, {
        name: input.name?.trim(),
        sku: input.sku?.trim(),
        barcode: input.barcode?.trim(),
        activeIngredient: input.activeIngredient?.trim(),
        categoryId: input.categoryId,
        unit: input.unit?.trim(),
        salePrice: input.salePrice,
        minStock: input.minStock,
        isActive: input.isActive,
    });
};

export const deleteProduct = async (id: string): Promise<Product> => {
    const existing = await productsRepo.getProductById(id);
    if (!existing) {
        throw notFound('Producto');
    }

    return productsRepo.updateProduct(id, { isActive: false });
};
