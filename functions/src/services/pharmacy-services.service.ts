import { Timestamp } from 'firebase-admin/firestore';
import { PharmacyService, ServiceTaxMode, ServiceType } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as servicesRepo from '../repositories/pharmacy-services.repository';

/** Quién dio de alta o modificó el servicio; se sella en `createdBy`/`updatedBy`. */
export interface ServiceActor {
    userId: string;
}

export const listPharmacyServices = async (filters: {
    activeOnly?: boolean;
    serviceType?: ServiceType;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: PharmacyService[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await servicesRepo.listPharmacyServicesPage({
        activeOnly: filters.activeOnly,
        serviceType: filters.serviceType,
        search: filters.search?.trim() || undefined,
        page,
        limit,
    });
    return { items, meta: buildListMeta(page, limit, total) };
};

/**
 * Servicio tal como lo guarda el SQLite local del POS. **Es exactamente lo que
 * la caja necesita para cobrar sin red**, ni un campo más: la bitácora de
 * autoría (`createdBy`/`updatedBy`, `createdAt`) no la lee nadie en el
 * mostrador y es peso en cada pull.
 */
export interface SyncPharmacyService {
    id: string;
    code: string;
    name: string;
    description?: string;
    serviceType: ServiceType;
    price: number;
    taxMode: ServiceTaxMode;
    hasIeps: boolean;
    iepsRate?: number;
    commissionRate: number;
    requiresPerformer: boolean;
    isActive: boolean;
    /** Cursor del pull incremental (`updatedSince` de la siguiente corrida). */
    updatedAt: Timestamp;
}

const toSyncService = (service: PharmacyService): SyncPharmacyService => ({
    id: service.id,
    code: service.code,
    name: service.name,
    ...(service.description ? { description: service.description } : {}),
    serviceType: service.serviceType,
    price: service.price,
    taxMode: service.taxMode,
    hasIeps: service.hasIeps,
    ...(service.iepsRate === undefined ? {} : { iepsRate: service.iepsRate }),
    commissionRate: service.commissionRate,
    requiresPerformer: service.requiresPerformer,
    isActive: service.isActive,
    updatedAt: service.updatedAt,
});

/**
 * Catálogo para el pull local-first del POS: una sola llamada trae todo (o todo
 * lo cambiado desde `updatedSince`). Incluye inactivos a propósito —el catálogo
 * local necesita reflejar bajas, no solo altas.
 */
export const listPharmacyServicesForSync = async (filters: {
    updatedSince?: string;
}): Promise<{ items: SyncPharmacyService[] }> => {
    const services = await servicesRepo.listPharmacyServices({
        activeOnly: false,
        updatedSince: filters.updatedSince,
    });
    return { items: services.map(toSyncService) };
};

export const getPharmacyService = async (id: string): Promise<PharmacyService> => {
    const service = await servicesRepo.getPharmacyServiceById(id);
    if (!service) {
        throw notFound('Servicio');
    }
    return service;
};

export const createPharmacyService = async (
    input: {
        code: string;
        name: string;
        description?: string;
        serviceType: ServiceType;
        price: number;
        taxMode: ServiceTaxMode;
        hasIeps: boolean;
        iepsRate?: number;
        commissionRate: number;
        requiresPerformer: boolean;
    },
    actor: ServiceActor,
): Promise<PharmacyService> => {
    const code = input.code.trim();
    const name = input.name.trim();
    if (!code || !name) {
        throw badRequest('Clave y nombre son requeridos');
    }
    if (input.price <= 0) {
        throw badRequest('El precio debe ser mayor a cero');
    }

    return servicesRepo.createPharmacyService({
        code,
        name,
        description: input.description?.trim(),
        serviceType: input.serviceType,
        price: input.price,
        taxMode: input.taxMode,
        hasIeps: input.hasIeps,
        iepsRate: input.iepsRate,
        commissionRate: input.commissionRate,
        requiresPerformer: input.requiresPerformer,
        isActive: true,
        createdBy: actor.userId,
        updatedBy: actor.userId,
    });
};

export const updatePharmacyService = async (
    id: string,
    input: Partial<{
        code: string;
        name: string;
        description: string;
        serviceType: ServiceType;
        price: number;
        taxMode: ServiceTaxMode;
        hasIeps: boolean;
        iepsRate: number;
        commissionRate: number;
        requiresPerformer: boolean;
        isActive: boolean;
    }>,
    actor: ServiceActor,
): Promise<PharmacyService> => {
    const existing = await servicesRepo.getPharmacyServiceById(id);
    if (!existing) {
        throw notFound('Servicio');
    }

    const hasIeps = input.hasIeps ?? existing.hasIeps;
    const iepsRate = input.iepsRate ?? existing.iepsRate;
    if (hasIeps && iepsRate === undefined) {
        throw badRequest('Un servicio con IEPS requiere la tasa (iepsRate)');
    }

    return servicesRepo.updatePharmacyService(id, {
        code: input.code?.trim(),
        name: input.name?.trim(),
        description: input.description?.trim(),
        serviceType: input.serviceType,
        price: input.price,
        taxMode: input.taxMode,
        hasIeps: input.hasIeps,
        iepsRate: input.iepsRate,
        commissionRate: input.commissionRate,
        requiresPerformer: input.requiresPerformer,
        isActive: input.isActive,
        updatedBy: actor.userId,
    });
};

/**
 * Baja **lógica**, como en productos y proveedores: un servicio ya cobrado no se
 * puede borrar sin dejar huérfanas las partidas de venta que lo referencian.
 */
export const deletePharmacyService = async (
    id: string,
    actor: ServiceActor,
): Promise<PharmacyService> => {
    const existing = await servicesRepo.getPharmacyServiceById(id);
    if (!existing) {
        throw notFound('Servicio');
    }
    return servicesRepo.updatePharmacyService(id, {
        isActive: false,
        updatedBy: actor.userId,
    });
};
