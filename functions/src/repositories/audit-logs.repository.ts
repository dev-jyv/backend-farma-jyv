import { AuditLog } from '../types';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('auditLogs');

const DEFAULT_LIST_DAYS = 30;

const mapLog = (id: string, data: FirebaseFirestore.DocumentData): AuditLog => ({
    id,
    action: data.action as AuditLog['action'],
    entity: data.entity as AuditLog['entity'],
    entityId: data.entityId as string,
    summary: data.summary as string,
    userId: data.userId as string,
    roleSlug: (data.roleSlug as string | null) ?? null,
    changes: (data.changes as AuditLog['changes']) ?? null,
    metadata: (data.metadata as AuditLog['metadata']) ?? null,
    createdAt: data.createdAt as AuditLog['createdAt'],
});

export const buildAuditPayload = (
    data: Omit<AuditLog, 'id' | 'createdAt'>,
): Omit<AuditLog, 'id'> => ({
    ...data,
    createdAt: now(),
});

export const createAuditLog = async (
    data: Omit<AuditLog, 'id' | 'createdAt'>,
): Promise<AuditLog> => {
    const payload = buildAuditPayload(data);
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const listAuditLogs = async (filters: {
    action?: AuditLog['action'];
    entity?: AuditLog['entity'];
    entityId?: string;
    userId?: string;
    from?: string;
    to?: string;
}): Promise<AuditLog[]> => {
    let query: FirebaseFirestore.Query = collection();

    // Un solo filtro de igualdad + el rango por fecha, para no exigir índices
    // compuestos nuevos; el resto se filtra en memoria sobre la ventana leída.
    if (filters.entityId) {
        query = query.where('entityId', '==', filters.entityId);
    } else if (filters.userId) {
        query = query.where('userId', '==', filters.userId);
    } else {
        const from = filters.from ??
            new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();
        query = query.where('createdAt', '>=', toTimestamp(from));
        if (filters.to) {
            query = query.where('createdAt', '<=', toTimestamp(filters.to));
        }
    }

    const snapshot = await query.get();
    let logs = snapshot.docs.map((doc) => mapLog(doc.id, doc.data()));

    if (filters.action) {
        logs = logs.filter((log) => log.action === filters.action);
    }
    if (filters.entity) {
        logs = logs.filter((log) => log.entity === filters.entity);
    }
    if (filters.entityId && filters.userId) {
        logs = logs.filter((log) => log.userId === filters.userId);
    }

    return logs.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
};
