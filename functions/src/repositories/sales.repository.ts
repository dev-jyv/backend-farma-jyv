import { Sale } from '../types';
import { paginate } from '../utils/pagination';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('sales');

const DEFAULT_LIST_DAYS = 30;

const mapSale = (id: string, data: FirebaseFirestore.DocumentData): Sale => ({
    id,
    folio: data.folio as string,
    productIds: data.productIds as string[] | undefined,
    items: data.items as Sale['items'],
    subtotal: data.subtotal as number,
    discountTotal: data.discountTotal as number,
    total: data.total as number,
    // Ausentes en ventas anteriores al desglose de impuestos / devoluciones.
    taxSummary: (data.taxSummary as Sale['taxSummary']) ?? null,
    refundedTotal: (data.refundedTotal as number | undefined) ?? 0,
    costTotal: (data.costTotal as number | null | undefined) ?? null,
    paymentMethod: data.paymentMethod as Sale['paymentMethod'],
    amountReceived: (data.amountReceived as number | null) ?? null,
    change: (data.change as number | null) ?? null,
    cardPaymentReference: (data.cardPaymentReference as string | null) ?? null,
    pointPayment: (data.pointPayment as Sale['pointPayment']) ?? null,
    cashSessionId: (data.cashSessionId as string | null) ?? null,
    cashierId: data.cashierId as string,
    customerId: (data.customerId as string | null) ?? null,
    customerName: (data.customerName as string | null) ?? null,
    prescription: (data.prescription as Sale['prescription']) ?? null,
    prescriptionRetained: Boolean(data.prescriptionRetained),
    controlledGroups: (data.controlledGroups as Sale['controlledGroups']) ?? [],
    billing: (data.billing as Sale['billing']) ?? null,
    invoiceStatus: (data.invoiceStatus as Sale['invoiceStatus']) ?? null,
    voidedAt: (data.voidedAt as Sale['voidedAt']) ?? null,
    voidedBy: (data.voidedBy as string | null) ?? null,
    createdAt: data.createdAt as Sale['createdAt'],
});

export const createSale = async (
    data: Omit<Sale, 'id' | 'createdAt'>,
): Promise<Sale> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const getSaleById = async (id: string): Promise<Sale | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapSale(doc.id, doc.data()!);
};

export const findSaleByPointOrderId = async (orderId: string): Promise<Sale | null> => {
    const byNested = await collection()
        .where('pointPayment.orderId', '==', orderId)
        .limit(1)
        .get();
    if (!byNested.empty) {
        const doc = byNested.docs[0];
        return mapSale(doc.id, doc.data());
    }

    const byReference = await collection()
        .where('cardPaymentReference', '==', orderId)
        .limit(1)
        .get();
    if (byReference.empty) {
        return null;
    }
    const doc = byReference.docs[0];
    return mapSale(doc.id, doc.data());
};

export const listSales = async (filters: {
    productId?: string;
    from?: string;
    to?: string;
    cashSessionId?: string;
    includeVoided?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: Sale[]; total: number }> => {
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

    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    let sales = snapshot.docs.map((doc) => mapSale(doc.id, doc.data()));

    if (!filters.includeVoided) {
        sales = sales.filter((sale) => sale.voidedAt === null);
    }

    if (filters.productId) {
        sales = sales.filter((sale) =>
            sale.productIds?.includes(filters.productId!) ||
            sale.items.some((item) => item.productId === filters.productId),
        );
    }

    if (filters.page !== undefined || filters.limit !== undefined) {
        return paginate(sales, filters.page ?? 1, filters.limit ?? 100);
    }

    return { items: sales, total: sales.length };
};
