import { badRequest } from './errors';

export interface ListMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

const MAX_PAGE_LIMIT = 100;

export const parsePagination = (page?: number, limit?: number): { page: number; limit: number } => {
    const resolvedPage = page ?? 1;
    const resolvedLimit = limit ?? 100;

    if (resolvedPage < 1) {
        throw badRequest('La página debe ser mayor a cero');
    }

    if (resolvedLimit < 1) {
        throw badRequest('El límite debe ser mayor a cero');
    }

    if (resolvedLimit > MAX_PAGE_LIMIT) {
        throw badRequest(`El límite no puede ser mayor a ${MAX_PAGE_LIMIT}`);
    }

    return { page: resolvedPage, limit: resolvedLimit };
};

export const paginate = <T>(
    items: T[],
    page: number,
    limit: number,
): { items: T[]; total: number } => {
    const offset = (page - 1) * limit;
    return {
        items: items.slice(offset, offset + limit),
        total: items.length,
    };
};

export const buildListMeta = (page: number, limit: number, total: number): ListMeta => ({
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
});

export const buildListResult = <T>(
    items: T[],
    page: number,
    limit: number,
): { items: T[]; meta: ListMeta } => {
    const paginated = paginate(items, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};
