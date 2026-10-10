import { CashReading } from '../types';
import { db } from '../utils/firestore';

const collection = () => db().collection('cashReadings');

export const mapCashReading = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): CashReading => ({
    id,
    folio: data.folio as string,
    cashSessionId: data.cashSessionId as string,
    summary: data.summary as CashReading['summary'],
    expectedCashAmount: data.expectedCashAmount as number,
    createdBy: data.createdBy as string,
    createdAt: data.createdAt as CashReading['createdAt'],
});

export const listReadingsForSession = async (
    cashSessionId: string,
): Promise<CashReading[]> => {
    const snapshot = await collection()
        .where('cashSessionId', '==', cashSessionId)
        .get();
    return snapshot.docs
        .map((doc) => mapCashReading(doc.id, doc.data()))
        .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
};
