import { badRequest } from './errors';

export interface ListMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export const MAX_PAGE_LIMIT = 100;

/**
 * `maxLimit` sube el tope solo donde el caso de uso lo justifica (el libro de
 * control de COFEPRIS se entrega por periodo completo, no de 100 en 100). El
 * default sigue en 100 para el resto de la API.
 */
export const parsePagination = (
    page?: number,
    limit?: number,
    options: { maxLimit?: number } = {},
): { page: number; limit: number } => {
    const maxLimit = options.maxLimit ?? MAX_PAGE_LIMIT;
    const resolvedPage = page ?? 1;
    const resolvedLimit = limit ?? Math.min(100, maxLimit);

    if (resolvedPage < 1) {
        throw badRequest('La página debe ser mayor a cero');
    }

    if (resolvedLimit < 1) {
        throw badRequest('El límite debe ser mayor a cero');
    }

    if (resolvedLimit > maxLimit) {
        throw badRequest(`El límite no puede ser mayor a ${maxLimit}`);
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
