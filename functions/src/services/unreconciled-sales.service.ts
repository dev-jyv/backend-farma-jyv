import { UnreconciledSale } from '../types';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import { toTimestamp } from '../utils/firestore';
import * as unreconciledRepo from '../repositories/unreconciled-sales.repository';
import { recordAudit } from './audit.service';

/**
 * Ventas cobradas en la caja que el servidor no pudo registrar como venta.
 *
 * El dinero ya entró y el ticket ya se imprimió, así que el movimiento no puede
 * perderse; pero meterlas en `sales` a la fuerza descuadraría el inventario —el
 * rechazo suele ser justamente que el stock remoto no alcanza—. Quedan aquí,
 * auditadas, hasta que alguien concilie el inventario y decida qué hacer.
 */
export const recordUnreconciledSale = async (input: {
    localId: string;
    localFolio?: string;
    reason: string;
    total: number;
    occurredAt?: string;
    cashSessionId?: string;
    payload: Record<string, unknown>;
    cashierId: string;
    roleSlug?: string | null;
}): Promise<UnreconciledSale> => {
    const sale = await unreconciledRepo.saveUnreconciledSale({
        localId: input.localId,
        localFolio: input.localFolio ?? null,
        reason: input.reason,
        total: input.total,
        payload: input.payload,
        cashierId: input.cashierId,
        cashSessionId: input.cashSessionId ?? null,
        occurredAt: input.occurredAt ? toTimestamp(input.occurredAt) : null,
    });

    await recordAudit({
        action: 'sale.unreconciled',
        entity: 'unreconciledSale',
        entityId: sale.id,
        summary: `Venta cobrada en caja por ${input.total.toFixed(2)} ` +
            `sin registrar: ${input.reason}`,
        userId: input.cashierId,
        roleSlug: input.roleSlug ?? null,
        metadata: {
            localId: input.localId,
            localFolio: input.localFolio ?? null,
            reason: input.reason,
            total: input.total,
        },
    });

    return sale;
};

export const listUnreconciledSales = async (filters: {
    from?: string;
    to?: string;
    includeResolved?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: UnreconciledSale[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await unreconciledRepo.listUnreconciledSales({
        ...filters,
        page,
        limit,
    });
    return { items, meta: buildListMeta(page, limit, total) };
};

/** La marca como atendida; el documento se conserva como rastro. */
export const resolveUnreconciledSale = async (id: string, resolvedBy: string): Promise<void> => {
    await unreconciledRepo.resolveUnreconciledSale(id, resolvedBy);
};
