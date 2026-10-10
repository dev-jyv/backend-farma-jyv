import { Timestamp } from 'firebase-admin/firestore';
import { ServiceProvider } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as providersRepo from '../repositories/service-providers.repository';

export const listServiceProviders = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: ServiceProvider[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await providersRepo.listServiceProvidersPage({
        activeOnly: filters.activeOnly,
        search: filters.search?.trim() || undefined,
        page,
        limit,
    });
    return { items, meta: buildListMeta(page, limit, total) };
};

/** Doctor tal como lo guarda el SQLite local del POS. */
export interface SyncServiceProvider {
    id: string;
    name: string;
    license?: string;
    defaultCommissionRate?: number;
    isActive: boolean;
    /** Cursor del pull incremental (`updatedSince` de la siguiente corrida). */
    updatedAt: Timestamp;
}

const toSyncProvider = (provider: ServiceProvider): SyncServiceProvider => ({
    id: provider.id,
    name: provider.name,
    ...(provider.license ? { license: provider.license } : {}),
    ...(provider.defaultCommissionRate === undefined
        ? {}
        : { defaultCommissionRate: provider.defaultCommissionRate }),
    isActive: provider.isActive,
    updatedAt: provider.updatedAt,
});

/** Padrón para el pull local-first del POS; incluye bajas, igual que productos. */
export const listServiceProvidersForSync = async (filters: {
    updatedSince?: string;
}): Promise<{ items: SyncServiceProvider[] }> => {
    const providers = await providersRepo.listServiceProviders({
        activeOnly: false,
        updatedSince: filters.updatedSince,
    });
    return { items: providers.map(toSyncProvider) };
};

export const getServiceProvider = async (id: string): Promise<ServiceProvider> => {
    const provider = await providersRepo.getServiceProviderById(id);
    if (!provider) {
        throw notFound('Doctor');
    }
    return provider;
};

export const createServiceProvider = async (input: {
    name: string;
    license?: string;
    defaultCommissionRate?: number;
}): Promise<ServiceProvider> => {
    const name = input.name.trim();
    if (!name) {
        throw badRequest('El nombre es requerido');
    }

    return providersRepo.createServiceProvider({
        name,
        license: input.license?.trim(),
        defaultCommissionRate: input.defaultCommissionRate,
        isActive: true,
    });
};

export const updateServiceProvider = async (
    id: string,
    input: {
        name?: string;
        license?: string;
        defaultCommissionRate?: number;
        isActive?: boolean;
    },
): Promise<ServiceProvider> => {
    const existing = await providersRepo.getServiceProviderById(id);
    if (!existing) {
        throw notFound('Doctor');
    }

    return providersRepo.updateServiceProvider(id, {
        name: input.name?.trim(),
        license: input.license?.trim(),
        defaultCommissionRate: input.defaultCommissionRate,
        isActive: input.isActive,
    });
};

/**
 * Baja **lógica**: las comisiones ya acreditadas apuntan a este id, así que
 * borrarlo dejaría el corte del doctor sin a quién atribuirlo.
 */
export const deleteServiceProvider = async (id: string): Promise<ServiceProvider> => {
    const existing = await providersRepo.getServiceProviderById(id);
    if (!existing) {
        throw notFound('Doctor');
    }
    return providersRepo.updateServiceProvider(id, { isActive: false });
};
