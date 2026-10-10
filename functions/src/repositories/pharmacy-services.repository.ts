import { PharmacyService, ServiceType } from '../types';
import { conflict, notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('pharmacyServices');

const toService = (
    doc: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.QueryDocumentSnapshot,
): PharmacyService => ({ id: doc.id, ...doc.data() } as PharmacyService);

/**
 * Corre dentro de la misma transacción que la escritura, igual que en productos:
 * dos altas concurrentes con la misma clave pasarían las dos si se validara
 * antes de abrir la transacción.
 */
const assertCodeIsFree = async (
    transaction: FirebaseFirestore.Transaction,
    code: string,
    excludeId?: string,
): Promise<void> => {
    const snapshot = await transaction.get(collection().where('code', '==', code).limit(1));
    if (snapshot.empty) {
        return;
    }
    if (snapshot.docs[0].id === excludeId) {
        return;
    }
    throw conflict('Ya existe un servicio con esa clave');
};

/**
 * Lectura completa sin paginar, para el pull local-first del POS. Incluye
 * inactivos a propósito: el catálogo local necesita reflejar bajas, no solo
 * altas.
 */
export const listPharmacyServices = async (filters: {
    activeOnly?: boolean;
    serviceType?: ServiceType;
    /** Solo servicios con `updatedAt` posterior a esta fecha (sync incremental). */
    updatedSince?: string;
} = {}): Promise<PharmacyService[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.activeOnly) {
        query = query.where('isActive', '==', true);
    }
    if (filters.serviceType) {
        query = query.where('serviceType', '==', filters.serviceType);
    }
    if (filters.updatedSince) {
        query = query.where('updatedAt', '>=', toTimestamp(filters.updatedSince));
    }

    const snapshot = await query.get();
    const services = snapshot.docs.map(toService);
    services.sort((a, b) => a.name.localeCompare(b.name));
    return services;
};

/**
 * Página del catálogo de servicios. Sin búsqueda la resuelve Firestore (índices
 * `[isActive, name]` y `[isActive, serviceType, name]`); con búsqueda hay que
 * leer y filtrar en memoria, como en proveedores —recortar antes de filtrar
 * perdería coincidencias más allá de la página.
 */
export const listPharmacyServicesPage = async (filters: {
    activeOnly?: boolean;
    serviceType?: ServiceType;
    search?: string;
    page: number;
    limit: number;
}): Promise<{ items: PharmacyService[]; total: number }> => {
    if (!filters.search) {
        let query: FirebaseFirestore.Query = collection();
        if (filters.activeOnly) {
            query = query.where('isActive', '==', true);
        }
        if (filters.serviceType) {
            query = query.where('serviceType', '==', filters.serviceType);
        }
        return paginateQuery(
            query.orderBy('name', 'asc'),
            toService,
            filters.page,
            filters.limit,
        );
    }

    const services = await listPharmacyServices({
        activeOnly: filters.activeOnly,
        serviceType: filters.serviceType,
    });
    const term = filters.search.trim().toLowerCase();
    const matches = services.filter(
        (service) =>
            service.name.toLowerCase().includes(term) ||
            service.code.toLowerCase().includes(term) ||
            (service.description?.toLowerCase().includes(term) ?? false),
    );

    return paginate(matches, filters.page, filters.limit);
};

export const getPharmacyServiceById = async (id: string): Promise<PharmacyService | null> => {
    const doc = await collection().doc(id).get();
    return doc.exists ? toService(doc) : null;
};

export const createPharmacyService = async (
    data: Omit<PharmacyService, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<PharmacyService> => db().runTransaction(async (transaction) => {
    await assertCodeIsFree(transaction, data.code);

    const timestamp = now();
    const ref = collection().doc();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    transaction.create(ref, payload);
    return { id: ref.id, ...payload };
});

export const updatePharmacyService = async (
    id: string,
    data: Partial<Omit<PharmacyService, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<PharmacyService> => db().runTransaction(async (transaction) => {
    const docRef = collection().doc(id);
    // La lectura del documento va antes que la de la consulta de duplicados:
    // Firestore no admite lecturas después de la primera escritura, y así el
    // 404 sale sin haber pagado la búsqueda por clave.
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) {
        throw notFound('Servicio');
    }
    if (data.code) {
        await assertCodeIsFree(transaction, data.code, id);
    }

    const timestamp = now();
    transaction.update(docRef, { ...data, updatedAt: timestamp });
    return { ...snapshot.data(), ...data, id, updatedAt: timestamp } as PharmacyService;
});
