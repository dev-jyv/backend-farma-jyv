import { AccruedExpense, CashMovement, ExpenseCategory, ExpensePaymentMethod } from '../types';
import { db, fromDate, now } from '../utils/firestore';
import { badRequest, notFound } from '../utils/errors';

const collection = () => db().collection('accruedExpenses');
const cashMovementsCollection = () => db().collection('cashMovements');

const map = (doc: FirebaseFirestore.DocumentSnapshot): AccruedExpense =>
    ({ id: doc.id, ...doc.data() }) as AccruedExpense;

export const listAccrued = async (filters: {
    from?: Date;
    to?: Date;
} = {}): Promise<AccruedExpense[]> => {
    let query = collection().orderBy('accruedAt', 'desc') as FirebaseFirestore.Query;
    if (filters.from) {
        query = query.where('accruedAt', '>=', fromDate(filters.from));
    }
    if (filters.to) {
        query = query.where('accruedAt', '<=', fromDate(filters.to));
    }
    const snapshot = await query.get();
    return snapshot.docs.map(map);
};

export const getById = async (id: string): Promise<AccruedExpense | null> => {
    const doc = await collection().doc(id).get();
    return doc.exists ? map(doc) : null;
};

export const getByIds = async (ids: string[]): Promise<AccruedExpense[]> => {
    if (ids.length === 0) {
        return [];
    }
    const docs = await db().getAll(...ids.map((id) => collection().doc(id)));
    return docs.filter((doc) => doc.exists).map(map);
};

export interface RecurringAccrualInput {
    id: string;
    category: ExpenseCategory;
    concept: string;
    description: string | null;
    amount: number;
    accruedAt: Date;
    dueDate: Date;
    recurringExpenseId: string;
    recurringMonth: string;
}

/**
 * Crea los devengados de gastos fijos con id determinista. La transacción lee
 * los ids antes de escribir: dos generaciones simultáneas del mismo mes no
 * pueden duplicar, porque la segunda ve el documento de la primera.
 */
export const createRecurringAccruals = async (
    entries: RecurringAccrualInput[],
    createdBy: string,
    createdByLabel?: string,
): Promise<{ created: AccruedExpense[]; existingIds: string[] }> => {
    if (entries.length === 0) {
        return { created: [], existingIds: [] };
    }
    const firestore = db();
    return firestore.runTransaction(async (transaction) => {
        const refs = entries.map((entry) => collection().doc(entry.id));
        const docs = await transaction.getAll(...refs);
        const timestamp = now();
        const created: AccruedExpense[] = [];
        const existingIds: string[] = [];

        entries.forEach(({ id, accruedAt, dueDate, ...entry }, index) => {
            if (docs[index].exists) {
                existingIds.push(id);
                return;
            }
            const payload = {
                ...entry,
                accruedAt: fromDate(accruedAt),
                dueDate: fromDate(dueDate),
                paidTotal: 0,
                lastPaymentAt: null,
                createdBy,
                createdByLabel: createdByLabel ?? null,
                createdAt: timestamp,
                updatedBy: null,
                updatedAt: null,
            };
            transaction.create(refs[index], payload);
            created.push({ id, ...payload });
        });

        return { created, existingIds };
    });
};

export const create = async (input: {
    category: ExpenseCategory;
    concept: string;
    description?: string;
    amount: number;
    accruedAt: Date;
    dueDate?: Date;
    createdBy: string;
    createdByLabel?: string;
}): Promise<AccruedExpense> => {
    const payload = {
        category: input.category,
        concept: input.concept,
        description: input.description ?? null,
        amount: input.amount,
        accruedAt: fromDate(input.accruedAt),
        dueDate: input.dueDate ? fromDate(input.dueDate) : null,
        paidTotal: 0,
        lastPaymentAt: null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        createdAt: now(),
        updatedBy: null,
        updatedAt: null,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

/**
 * Paga —total o parcialmente— un gasto devengado.
 *
 * El movimiento de efectivo se escribe como **`withdrawal`**, nunca como
 * `expense`: el gasto ya pegó en el estado de resultados el día que se devengó,
 * y volver a registrarlo como gasto lo contaría dos veces. El saldo del
 * devengado y el movimiento viajan en el mismo lote atómico, por la misma razón
 * que en los abonos a proveedor: a medias, el dinero sale sin bajar la deuda o
 * la deuda baja sin que salga dinero.
 */
export const registerPayment = async (
    accruedExpenseId: string,
    input: {
        amount: number;
        paymentMethod: ExpensePaymentMethod;
        paidAt: Date;
        bankAccountId?: string;
        reason: string;
        createdBy: string;
        createdByLabel?: string;
    },
): Promise<{ accrued: AccruedExpense; movement: CashMovement }> => {
    const firestore = db();
    const accruedRef = collection().doc(accruedExpenseId);
    const movementRef = cashMovementsCollection().doc();
    const timestamp = now();

    const accruedDoc = await accruedRef.get();
    if (!accruedDoc.exists) {
        throw notFound('Gasto por pagar');
    }
    const accrued = map(accruedDoc);

    const balance = Math.round((accrued.amount - accrued.paidTotal) * 100) / 100;
    // Un centavo de tolerancia, el mismo criterio que los abonos a proveedor.
    if (input.amount > balance + 0.01) {
        throw badRequest(`El pago supera el saldo del gasto (${balance.toFixed(2)})`);
    }

    const paidTotal = Math.round((accrued.paidTotal + input.amount) * 100) / 100;
    const paidAt = fromDate(input.paidAt);

    const movement = {
        cashSessionId: null,
        type: 'withdrawal' as const,
        amount: input.amount,
        reason: input.reason,
        category: null,
        description: null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        paymentMethod: input.paymentMethod,
        bankAccountId: input.paymentMethod === 'cash' ? null : (input.bankAccountId ?? null),
        accruedExpenseId,
        occurredAt: paidAt,
        createdAt: timestamp,
    };

    const batch = firestore.batch();
    batch.set(movementRef, movement);
    batch.update(accruedRef, {
        paidTotal,
        lastPaymentAt: paidAt,
        updatedAt: timestamp,
        updatedBy: input.createdBy,
    });
    await batch.commit();

    return {
        accrued: { ...accrued, paidTotal, lastPaymentAt: paidAt },
        movement: { id: movementRef.id, ...movement } as CashMovement,
    };
};
