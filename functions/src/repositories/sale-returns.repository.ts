import { SaleReturn } from '../types';
import { db, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('saleReturns');

const DEFAULT_LIST_DAYS = 30;

export const mapSaleReturn = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): SaleReturn => ({
    id,
    folio: data.folio as string,
    saleId: data.saleId as string,
    saleFolio: data.saleFolio as string,
    items: data.items as SaleReturn['items'],
    productIds: (data.productIds as string[] | undefined) ?? [],
    refundTotal: data.refundTotal as number,
    refundMethod: data.refundMethod as SaleReturn['refundMethod'],
    taxSummary: data.taxSummary as SaleReturn['taxSummary'],
    pointRefund: (data.pointRefund as SaleReturn['pointRefund']) ?? null,
    reason: data.reason as string,
    cashSessionId: data.cashSessionId as string,
    createdBy: data.createdBy as string,
    createdAt: data.createdAt as SaleReturn['createdAt'],
});

export const getSaleReturnById = async (id: string): Promise<SaleReturn | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapSaleReturn(doc.id, doc.data()!);
};

/** Devoluciones de una venta. Usado para validar cuánto queda por devolver. */
export const listReturnsForSale = async (saleId: string): Promise<SaleReturn[]> => {
    const snapshot = await collection().where('saleId', '==', saleId).get();
    return snapshot.docs
        .map((doc) => mapSaleReturn(doc.id, doc.data()))
        .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
};

export const listReturnsForSession = async (
    cashSessionId: string,
): Promise<SaleReturn[]> => {
    const snapshot = await collection()
        .where('cashSessionId', '==', cashSessionId)
        .get();
    return snapshot.docs.map((doc) => mapSaleReturn(doc.id, doc.data()));
};

export const listSaleReturns = async (filters: {
    saleId?: string;
    from?: string;
    to?: string;
    cashSessionId?: string;
}): Promise<SaleReturn[]> => {
    if (filters.saleId) {
        return listReturnsForSale(filters.saleId);
    }

    let query: FirebaseFirestore.Query = collection();

    if (filters.cashSessionId) {
        query = query.where('cashSessionId', '==', filters.cashSessionId);
    } else {
        const from = filters.from ??
            new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();
        query = query.where('createdAt', '>=', toTimestamp(from));
        if (filters.to) {
            query = query.where('createdAt', '<=', toTimestamp(filters.to));
        }
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();
    return snapshot.docs.map((doc) => mapSaleReturn(doc.id, doc.data()));
};
