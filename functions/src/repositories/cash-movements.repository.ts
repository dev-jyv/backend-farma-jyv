import { CashMovement, CashMovementType, ExpenseCategory } from '../types';
import { db, now } from '../utils/firestore';
import { paginate } from '../utils/pagination';

const collection = () => db().collection('cashMovements');

export const listMovementsForSession = async (
    cashSessionId: string,
): Promise<CashMovement[]> => {
    const snapshot = await collection()
        .where('cashSessionId', '==', cashSessionId)
        .orderBy('createdAt', 'desc')
        .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as CashMovement));
};

export const createMovement = async (input: {
    /** `null` en la caja de la farmacia: movimiento sin turno, fuera del corte. */
    cashSessionId: string | null;
    type: CashMovementType;
    amount: number;
    reason: string;
    category?: ExpenseCategory;
    description?: string;
    createdBy: string;
    createdByLabel?: string;
}): Promise<CashMovement> => {
    const payload = {
        cashSessionId: input.cashSessionId,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
        category: input.category ?? null,
        description: input.description ?? null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        createdAt: now(),
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const getMovementById = async (id: string): Promise<CashMovement | null> => {
    const doc = await collection().doc(id).get();
    return doc.exists ? ({ id: doc.id, ...doc.data() } as CashMovement) : null;
};

/**
 * Corrige un gasto ya registrado. Solo los campos capturables: `type`,
 * `cashSessionId`, `createdBy` y `createdAt` son inmutables — mover un gasto de
 * turno o de autor sería reescribir el rastro, no corregir una cifra.
 */
export const updateMovement = async (
    id: string,
    patch: {
        amount?: number;
        reason?: string;
        category?: ExpenseCategory;
        description?: string | null;
    },
): Promise<CashMovement> => {
    const data: Record<string, unknown> = { updatedAt: now() };
    if (patch.amount !== undefined) data.amount = patch.amount;
    if (patch.reason !== undefined) data.reason = patch.reason;
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.description !== undefined) data.description = patch.description;

    const ref = collection().doc(id);
    await ref.update(data);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as CashMovement;
};

interface ListAllMovementsFilters {
    from?: string;
    to?: string;
    type?: CashMovementType;
    category?: ExpenseCategory;
    cashSessionId?: string;
    page: number;
    limit: number;
}

/** Igual que la auditoría de cortes: sin `from`, últimos 90 días. */
const DEFAULT_AUDIT_DAYS = 90;

const defaultFrom = (): Date =>
    new Date(Date.now() - DEFAULT_AUDIT_DAYS * 24 * 60 * 60 * 1000);

/** Auditoría global (solo admin): gastos/depósitos/retiros de todas las cajas. */
export const listAllMovements = async (
    filters: ListAllMovementsFilters,
): Promise<{ items: CashMovement[]; total: number }> => {
    let query = collection().orderBy('createdAt', 'desc') as FirebaseFirestore.Query;
    query = query.where('createdAt', '>=', filters.from ? new Date(filters.from) : defaultFrom());
    if (filters.to) {
        query = query.where('createdAt', '<=', new Date(filters.to));
    }
    if (filters.cashSessionId) {
        query = query.where('cashSessionId', '==', filters.cashSessionId);
    }
    const snapshot = await query.get();
    let movements = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() }) as CashMovement,
    );
    if (filters.type) {
        movements = movements.filter((movement) => movement.type === filters.type);
    }
    if (filters.category) {
        movements = movements.filter((movement) => movement.category === filters.category);
    }
    // Recorte después de filtrar: el `total` del `meta` es el del filtro aplicado.
    return paginate(movements, filters.page, filters.limit);
};
