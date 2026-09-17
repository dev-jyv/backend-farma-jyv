import {
    CashMovement,
    CashMovementType,
    ExpenseCategory,
    ExpensePaymentMethod,
} from '../types';
import { db, fromDate, now } from '../utils/firestore';
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
    /** Ausente = `cash`: es lo que era todo movimiento antes de contabilidad. */
    paymentMethod?: ExpensePaymentMethod;
    /** Fecha a la que pertenece el gasto. Ausente = el instante de captura. */
    occurredAt?: Date;
    /** Cuenta de la que salió, cuando no salió del cajón. */
    bankAccountId?: string;
}): Promise<CashMovement> => {
    const createdAt = now();
    const payload = {
        cashSessionId: input.cashSessionId,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
        category: input.category ?? null,
        description: input.description ?? null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        paymentMethod: input.paymentMethod ?? 'cash',
        bankAccountId: input.bankAccountId ?? null,
        // Se escribe **siempre**, también cuando coincide con la captura: así la
        // consulta de contabilidad ordena por un solo campo y no tiene que
        // decidir documento por documento cuál de los dos vale.
        occurredAt: input.occurredAt ? fromDate(input.occurredAt) : createdAt,
        createdAt,
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
        paymentMethod?: ExpensePaymentMethod;
        occurredAt?: Date;
    },
): Promise<CashMovement> => {
    const data: Record<string, unknown> = { updatedAt: now() };
    if (patch.amount !== undefined) data.amount = patch.amount;
    if (patch.reason !== undefined) data.reason = patch.reason;
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.paymentMethod !== undefined) data.paymentMethod = patch.paymentMethod;
    if (patch.occurredAt !== undefined) data.occurredAt = fromDate(patch.occurredAt);

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

/**
 * Fecha a la que pertenece el movimiento para efectos contables. Los documentos
 * anteriores a contabilidad no traen `occurredAt`; en ellos captura y ocurrencia
 * eran el mismo instante, así que `createdAt` es la respuesta correcta.
 */
export const effectiveDate = (movement: CashMovement): Date =>
    (movement.occurredAt ?? movement.createdAt).toDate();

/**
 * Cuántos días hacia atrás puede fecharse un gasto capturado hoy. Es el mismo
 * número que usa `listForPeriod` para ensanchar la ventana de lectura: el tope
 * del alta y el colchón de la consulta tienen que ser el mismo, o un gasto
 * fechado más atrás quedaría registrado y aun así fuera de su propio reporte.
 */
export const MAX_BACKDATE_DAYS = 90;

/**
 * Movimientos cuya **fecha de ocurrencia** cae en el periodo, para el estado de
 * resultados.
 *
 * Consulta por `createdAt` y no por `occurredAt` a propósito: un rango sobre
 * `occurredAt` descarta en silencio todo documento que no tenga el campo, y los
 * movimientos anteriores a contabilidad no lo tienen —el periodo entero de
 * historia se perdería—. Se lee una ventana ensanchada `MAX_BACKDATE_DAYS` por
 * cada lado y se recorta en memoria por la fecha efectiva.
 */
export const listForPeriod = async (filters: {
    from: string;
    to: string;
}): Promise<CashMovement[]> => {
    const padMs = MAX_BACKDATE_DAYS * 24 * 60 * 60 * 1000;
    const from = new Date(filters.from);
    const to = new Date(filters.to);

    const snapshot = await collection()
        .where('createdAt', '>=', new Date(from.getTime() - padMs))
        .where('createdAt', '<=', new Date(to.getTime() + padMs))
        .orderBy('createdAt', 'desc')
        .get();

    return snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }) as CashMovement)
        .filter((movement) => {
            const date = effectiveDate(movement);
            return date >= from && date <= to;
        });
};
