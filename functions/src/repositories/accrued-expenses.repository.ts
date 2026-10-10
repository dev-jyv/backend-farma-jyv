import { AccruedExpense, CashMovement, ExpenseCategory, ExpensePaymentMethod } from '../types';
import { db, fromDate, now } from '../utils/firestore';
import { badRequest, notFound } from '../utils/errors';

const collection = () => db().collection('accruedExpenses');
const cashMovementsCollection = () => db().collection('cashMovements');

/**
 * Un gasto fijo pega en contabilidad **por lo pagado**, nunca por lo
 * presupuestado: su importe es su `paidTotal`. Los devengados que la versión
 * anterior generó al monto de la plantilla quedan así en lo realmente pagado
 * sin reescribir los documentos.
 */
const map = (doc: FirebaseFirestore.DocumentSnapshot): AccruedExpense => {
    const accrued = { id: doc.id, ...doc.data() } as AccruedExpense;
    return accrued.recurringExpenseId ? { ...accrued, amount: accrued.paidTotal } : accrued;
};

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
    return snapshot.docs.map(map).filter((accrued) => accrued.amount > 0);
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

interface PaymentInput {
    amount: number;
    paymentMethod: ExpensePaymentMethod;
    paidAt: Date;
    bankAccountId?: string;
    reason: string;
    createdBy: string;
    createdByLabel?: string;
}

/**
 * El movimiento de efectivo se escribe como **`withdrawal`**, nunca como
 * `expense`: el gasto ya pega en el estado de resultados por el devengado, y
 * volver a registrarlo como gasto lo contaría dos veces.
 */
const paymentMovement = (accruedExpenseId: string, input: PaymentInput) => ({
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
    occurredAt: fromDate(input.paidAt),
    createdAt: now(),
});

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/**
 * Paga —total o parcialmente— un gasto devengado capturado a mano. El saldo y
 * el movimiento viajan en el mismo lote atómico, por la misma razón que en los
 * abonos a proveedor: a medias, el dinero sale sin bajar la deuda o la deuda
 * baja sin que salga dinero.
 */
export const registerPayment = async (
    accruedExpenseId: string,
    input: PaymentInput,
): Promise<{ accrued: AccruedExpense; movement: CashMovement }> => {
    const accruedRef = collection().doc(accruedExpenseId);
    const movementRef = cashMovementsCollection().doc();

    const accruedDoc = await accruedRef.get();
    if (!accruedDoc.exists) {
        throw notFound('Gasto por pagar');
    }
    const accrued = map(accruedDoc);
    if (accrued.recurringExpenseId) {
        throw badRequest('Los gastos fijos se pagan desde la pestaña Gastos fijos');
    }

    const balance = roundMoney(accrued.amount - accrued.paidTotal);
    // Un centavo de tolerancia, el mismo criterio que los abonos a proveedor.
    if (input.amount > balance + 0.01) {
        throw badRequest(`El pago supera el saldo del gasto (${balance.toFixed(2)})`);
    }

    const paidTotal = roundMoney(accrued.paidTotal + input.amount);
    const movement = paymentMovement(accruedExpenseId, input);

    const batch = db().batch();
    batch.set(movementRef, movement);
    batch.update(accruedRef, {
        paidTotal,
        lastPaymentAt: movement.occurredAt,
        updatedAt: movement.createdAt,
        updatedBy: input.createdBy,
    });
    await batch.commit();

    return {
        accrued: { ...accrued, paidTotal, lastPaymentAt: movement.occurredAt },
        movement: { id: movementRef.id, ...movement } as CashMovement,
    };
};

export interface RecurringPaymentTarget {
    id: string;
    category: ExpenseCategory;
    concept: string;
    description: string | null;
    accruedAt: Date;
    dueDate: Date;
    recurringExpenseId: string;
    recurringMonth: string;
}

/**
 * Registra lo pagado de un gasto fijo en su mes: el devengado (id determinista
 * por plantilla y mes) nace con el primer pago y cada pago lo acumula. La
 * transacción lee antes de escribir, así dos pagos simultáneos no se pisan.
 */
export const recordRecurringPayment = async (
    target: RecurringPaymentTarget,
    input: PaymentInput,
): Promise<{ accrued: AccruedExpense; movement: CashMovement }> => {
    const firestore = db();
    const { id, accruedAt, dueDate, ...fields } = target;
    const accruedRef = collection().doc(id);
    const movementRef = cashMovementsCollection().doc();
    const movement = paymentMovement(id, input);

    const accrued = await firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(accruedRef);
        const paidTotal = roundMoney((doc.exists ? Number(doc.data()!.paidTotal ?? 0) : 0) +
            input.amount);
        const changes = {
            amount: paidTotal,
            paidTotal,
            lastPaymentAt: movement.occurredAt,
        };

        transaction.set(movementRef, movement);
        if (doc.exists) {
            transaction.update(accruedRef, {
                ...changes,
                updatedAt: movement.createdAt,
                updatedBy: input.createdBy,
            });
            return { ...(doc.data() as AccruedExpense), id, ...changes };
        }
        const payload = {
            ...fields,
            ...changes,
            accruedAt: fromDate(accruedAt),
            dueDate: fromDate(dueDate),
            createdBy: input.createdBy,
            createdByLabel: input.createdByLabel ?? null,
            createdAt: movement.createdAt,
            updatedBy: null,
            updatedAt: null,
        };
        transaction.create(accruedRef, payload);
        return { id, ...payload };
    });

    return { accrued, movement: { id: movementRef.id, ...movement } as CashMovement };
};
