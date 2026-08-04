import { ControlledLedgerEntry } from '../types';
import { db, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('controlledSalesLedger');

const DEFAULT_LIST_DAYS = 90;

export const mapLedgerEntry = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): ControlledLedgerEntry => ({
    id,
    type: data.type as ControlledLedgerEntry['type'],
    saleId: data.saleId as string,
    saleFolio: data.saleFolio as string,
    referenceFolio: (data.referenceFolio as string | null) ?? null,
    productId: data.productId as string,
    productName: data.productName as string,
    controlledGroup: data.controlledGroup as ControlledLedgerEntry['controlledGroup'],
    quantity: data.quantity as number,
    lotNumbers: (data.lotNumbers as string[] | undefined) ?? [],
    prescription: (data.prescription as ControlledLedgerEntry['prescription']) ?? null,
    prescriptionRetained: Boolean(data.prescriptionRetained),
    customerName: (data.customerName as string | null) ?? null,
    userId: data.userId as string,
    createdAt: data.createdAt as ControlledLedgerEntry['createdAt'],
});

export const listLedgerEntries = async (filters: {
    saleId?: string;
    productId?: string;
    from?: string;
    to?: string;
}): Promise<ControlledLedgerEntry[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.saleId) {
        query = query.where('saleId', '==', filters.saleId);
    } else if (filters.productId) {
        query = query.where('productId', '==', filters.productId);
    } else {
        const from = filters.from ??
            new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();
        query = query.where('createdAt', '>=', toTimestamp(from));
        if (filters.to) {
            query = query.where('createdAt', '<=', toTimestamp(filters.to));
        }
    }

    const snapshot = await query.get();
    return snapshot.docs
        .map((doc) => mapLedgerEntry(doc.id, doc.data()))
        .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
};
