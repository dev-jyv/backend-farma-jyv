import { CashSession, CashSessionSummary } from '../types';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('cashSessions');

export const createCashSession = async (
    data: Omit<CashSession, 'id' | 'openedAt'>,
): Promise<CashSession> => {
    const payload = { ...data, openedAt: now() };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const getCashSessionById = async (id: string): Promise<CashSession | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as CashSession;
};

export const getOpenSessionForUser = async (userId: string): Promise<CashSession | null> => {
    const snapshot = await collection()
        .where('openedBy', '==', userId)
        .where('closedAt', '==', null)
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as CashSession;
};

interface CloseCashSessionData {
    closedBy: string;
    countedCashAmount: number;
    expectedCashAmount: number;
    cashDifference: number;
    summary: CashSessionSummary;
}

export const closeCashSession = async (
    id: string,
    data: CloseCashSessionData,
): Promise<CashSession> => {
    const ref = collection().doc(id);
    const timestamp = now();
    await ref.update({
        closedAt: timestamp,
        closedBy: data.closedBy,
        countedCashAmount: data.countedCashAmount,
        expectedCashAmount: data.expectedCashAmount,
        cashDifference: data.cashDifference,
        summary: data.summary,
    });
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as CashSession;
};

export interface SessionSaleRow {
    paymentMethod: string;
    amountReceived: number | null;
    change: number | null;
    /** Efectivo aplicado a la venta; ausente en ventas anteriores al split mixto. */
    cashAmount: number | null;
    total: number;
    voidedAt: unknown | null;
}

export const listSalesForSession = async (cashSessionId: string): Promise<SessionSaleRow[]> => {
    const snapshot = await db()
        .collection('sales')
        .where('cashSessionId', '==', cashSessionId)
        .get();
    return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            paymentMethod: data.paymentMethod as string,
            amountReceived: data.amountReceived as number | null,
            change: data.change as number | null,
            cashAmount: (data.cashAmount as number | null | undefined) ?? null,
            total: data.total as number,
            voidedAt: data.voidedAt ?? null,
        };
    });
};

/** @deprecated use listSalesForSession */
export const listCashSalesForSession = async (
    cashSessionId: string,
): Promise<Array<Pick<SessionSaleRow, 'paymentMethod' | 'amountReceived' | 'change'>>> => {
    const sales = await listSalesForSession(cashSessionId);
    return sales
        .filter((sale) => sale.voidedAt === null)
        .map(({ paymentMethod, amountReceived, change }) => ({
            paymentMethod,
            amountReceived,
            change,
        }));
};
