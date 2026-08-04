import { CashMovement, CashMovementType } from '../types';
import { db, now } from '../utils/firestore';

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
    cashSessionId: string;
    type: CashMovementType;
    amount: number;
    reason: string;
    createdBy: string;
}): Promise<CashMovement> => {
    const payload = {
        cashSessionId: input.cashSessionId,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
        createdBy: input.createdBy,
        createdAt: now(),
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};
