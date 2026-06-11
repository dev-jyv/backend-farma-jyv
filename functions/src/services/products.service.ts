import { Product, ProductDetail, ProductWithCategory, Supplier, SupplierSummary } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as productsRepo from '../repositories/products.repository';
import * as categoriesRepo from '../repositories/categories.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';

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
    return { ...productData, stock, suppliers, category };
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
