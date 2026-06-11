import { Category } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as categoriesRepo from '../repositories/categories.repository';

export const listCategories = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Category[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await categoriesRepo.listCategories({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getCategory = async (id: string): Promise<Category> => {
    const category = await categoriesRepo.getCategoryById(id);
    if (!category) {
        throw notFound('Categoría');
    }
    return category;
};

export const createCategory = async (input: {
    name: string;
    description?: string;
}): Promise<Category> => {
    if (!input.name.trim()) {
        throw badRequest('El nombre es requerido');
    }

    return categoriesRepo.createCategory({
        name: input.name.trim(),
        description: input.description?.trim(),
        isActive: true,
    });
};

export const updateCategory = async (
    id: string,
    input: { name?: string; description?: string; isActive?: boolean },
): Promise<Category> => {
    const existing = await categoriesRepo.getCategoryById(id);
    if (!existing) {
        throw notFound('Categoría');
    }

    return categoriesRepo.updateCategory(id, {
        name: input.name?.trim(),
        description: input.description?.trim(),
        isActive: input.isActive,
    });
};

export const deleteCategory = async (id: string): Promise<Category> => {
    const existing = await categoriesRepo.getCategoryById(id);
    if (!existing) {
        throw notFound('Categoría');
    }

    return categoriesRepo.updateCategory(id, { isActive: false });
};
