import { ExpenseCategory, RecurringExpense } from '../types';
import { db, now } from '../utils/firestore';
import { notFound } from '../utils/errors';

const collection = () => db().collection('recurringExpenses');

const map = (doc: FirebaseFirestore.DocumentSnapshot): RecurringExpense =>
    ({ id: doc.id, ...doc.data() }) as RecurringExpense;

export const list = async (): Promise<RecurringExpense[]> => {
    const snapshot = await collection().orderBy('createdAt', 'asc').get();
    return snapshot.docs.map(map);
};

export const getById = async (id: string): Promise<RecurringExpense | null> => {
    const doc = await collection().doc(id).get();
    return doc.exists ? map(doc) : null;
};

export const create = async (input: {
    category: ExpenseCategory;
    concept: string;
    description?: string;
    amount: number;
    dueDay: number;
    createdBy: string;
}): Promise<RecurringExpense> => {
    const payload = {
        category: input.category,
        concept: input.concept,
        description: input.description ?? null,
        amount: input.amount,
        dueDay: input.dueDay,
        isActive: true,
        createdBy: input.createdBy,
        createdAt: now(),
        updatedBy: null,
        updatedAt: null,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const update = async (
    id: string,
    changes: Partial<Pick<
        RecurringExpense,
        'category' | 'concept' | 'description' | 'amount' | 'dueDay' | 'isActive'
    >>,
    updatedBy: string,
): Promise<RecurringExpense> => {
    const ref = collection().doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
        throw notFound('Gasto fijo');
    }
    await ref.update({ ...changes, updatedBy, updatedAt: now() });
    return map(await ref.get());
};
