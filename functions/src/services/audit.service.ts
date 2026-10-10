import { AuditAction, AuditEntity, AuditLog } from '../types';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { db } from '../utils/firestore';
import * as auditRepo from '../repositories/audit-logs.repository';

/**
 * Bitácora de acciones sensibles: dinero (anulaciones, descuentos forzados,
 * devoluciones, cortes con diferencia), precios y accesos (roles/permisos/estado
 * de usuario). Las altas rutinarias NO se auditan: inflarían Firestore y el
 * `stockMovements` ya cubre el rastro de inventario.
 *
 * Un fallo al escribir la bitácora **no** debe tumbar la operación de negocio ya
 * confirmada, así que `recordAudit` traga el error y lo deja en el log de la
 * Function. Cuando la escritura puede ir dentro de la transacción del caso de uso
 * (ajuste por conteo), usa `buildAuditWrite` para que sea atómica.
 */

/** Quién ejecutó la acción; se propaga desde el controller. */
export interface AuditActor {
    userId: string;
    roleSlug?: string | null;
}

export interface AuditInput {
    action: AuditAction;
    entity: AuditEntity;
    entityId: string;
    summary: string;
    userId: string;
    roleSlug?: string | null;
    changes?: Record<string, { before: unknown; after: unknown }> | null;
    metadata?: Record<string, unknown> | null;
}

const toPayload = (input: AuditInput) => ({
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    summary: input.summary,
    userId: input.userId,
    roleSlug: input.roleSlug ?? null,
    changes: input.changes ?? null,
    metadata: input.metadata ?? null,
});

export const recordAudit = async (input: AuditInput): Promise<void> => {
    try {
        await auditRepo.createAuditLog(toPayload(input));
    } catch (error) {
        console.error('No se pudo escribir la bitácora de auditoría', {
            action: input.action,
            entityId: input.entityId,
            error,
        });
    }
};

/** Escribe la bitácora dentro de una transacción existente. */
export const writeAuditInTransaction = (
    transaction: FirebaseFirestore.Transaction,
    input: AuditInput,
): void => {
    const ref = db().collection('auditLogs').doc();
    transaction.set(ref, auditRepo.buildAuditPayload(toPayload(input)));
};

/**
 * Diff superficial de los campos vigilados. Devuelve `null` si nada cambió, para
 * no escribir bitácoras vacías en un PATCH que no movió nada.
 */
export const diffFields = <T extends Record<string, unknown>>(
    before: T,
    after: Partial<T>,
    fields: Array<keyof T>,
): Record<string, { before: unknown; after: unknown }> | null => {
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of fields) {
        if (after[field] === undefined) {
            continue;
        }
        if (before[field] !== after[field]) {
            changes[String(field)] = { before: before[field], after: after[field] };
        }
    }
    return Object.keys(changes).length ? changes : null;
};

export const listAuditLogs = async (filters: {
    action?: AuditAction;
    entity?: AuditEntity;
    entityId?: string;
    userId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: AuditLog[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const logs = await auditRepo.listAuditLogs(filters);
    const paginated = paginate(logs, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};
