import { Sale, isSaleProductItem } from '../types';
import { db, now, toTimestamp } from '../utils/firestore';

const collection = () => db().collection('sales');

const DEFAULT_LIST_DAYS = 30;

const mapSale = (id: string, data: FirebaseFirestore.DocumentData): Sale => {
    const total = data.total as number;
    const cashAmount = (data.cashAmount as number | null | undefined) ?? null;
    return {
        id,
        folio: data.folio as string,
        productIds: data.productIds as string[] | undefined,
        items: data.items as Sale['items'],
        subtotal: data.subtotal as number,
        discountTotal: data.discountTotal as number,
        total,
        // Ausentes en ventas anteriores al desglose de impuestos / devoluciones.
        taxSummary: (data.taxSummary as Sale['taxSummary']) ?? null,
        refundedTotal: (data.refundedTotal as number | undefined) ?? 0,
        costTotal: (data.costTotal as number | null | undefined) ?? null,
        paymentMethod: data.paymentMethod as Sale['paymentMethod'],
        amountReceived: (data.amountReceived as number | null) ?? null,
        change: (data.change as number | null) ?? null,
        cashAmount,
        cardAmount: (data.cardAmount as number | null | undefined) ?? null,
        cardPaymentReference: (data.cardPaymentReference as string | null) ?? null,
        pointPayment: (data.pointPayment as Sale['pointPayment']) ?? null,
        cashSessionId: (data.cashSessionId as string | null) ?? null,
        cashierId: data.cashierId as string,
        customerId: (data.customerId as string | null) ?? null,
        customerName: (data.customerName as string | null) ?? null,
        prescription: (data.prescription as Sale['prescription']) ?? null,
        prescriptionRetained: Boolean(data.prescriptionRetained),
        controlledGroups: (data.controlledGroups as Sale['controlledGroups']) ?? [],
        // Partición farmacia/servicios con **defaults de compatibilidad**, los
        // mismos que usa `listSalesForSession` para el corte: una venta anterior
        // a los servicios no trae estos campos y se lee como 100 % farmacia.
        // Sin esto los reportes verían `undefined` y una venta histórica
        // desaparecería del desglose por rama.
        hasServices: (data.hasServices as boolean | undefined) ?? false,
        serviceIds: (data.serviceIds as string[] | undefined) ?? [],
        providerIds: (data.providerIds as string[] | undefined) ?? [],
        commissionTotal: (data.commissionTotal as number | undefined) ?? 0,
        commissionByProvider:
            (data.commissionByProvider as Record<string, number> | undefined) ?? {},
        pharmacyTotal: (data.pharmacyTotal as number | undefined) ?? total,
        servicesTotal: (data.servicesTotal as number | undefined) ?? 0,
        pharmacyCashAmount: (data.pharmacyCashAmount as number | undefined) ??
            (cashAmount ??
                ((data.amountReceived as number | null ?? 0) -
                    (data.change as number | null ?? 0))),
        servicesCashAmount: (data.servicesCashAmount as number | undefined) ?? 0,
        billing: (data.billing as Sale['billing']) ?? null,
        invoiceStatus: (data.invoiceStatus as Sale['invoiceStatus']) ?? null,
        voidedAt: (data.voidedAt as Sale['voidedAt']) ?? null,
        voidedBy: (data.voidedBy as string | null) ?? null,
        createdAt: data.createdAt as Sale['createdAt'],
    };
};

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

/**
 * Refresca la foto del cobro Point de una venta ya registrada (cambios que
 * ocurren del lado de Mercado Pago: reembolso, contracargo, cancelación).
 */
export const updateSalePointPayment = async (
    saleId: string,
    pointPayment: Sale['pointPayment'],
): Promise<void> => {
    await collection().doc(saleId).update({ pointPayment });
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

/**
 * Ventas del periodo en las que un doctor tiene comisión, por la consulta
 * indexada `providerIds array-contains` + rango de `createdAt`
 * (índice `[providerIds CONTAINS, createdAt ASC]`).
 *
 * Las anuladas se descartan **en memoria**, igual que hace el corte: agregar
 * `voidedAt` a la consulta obligaría a un índice más por cada combinación, y el
 * volumen de anuladas de un periodo es despreciable.
 */
export const listSalesByProvider = async (filters: {
    providerId: string;
    from?: string;
    to?: string;
    includeVoided?: boolean;
}): Promise<Sale[]> => {
    const from = filters.from ??
        new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let query: FirebaseFirestore.Query = collection()
        .where('providerIds', 'array-contains', filters.providerId)
        .where('createdAt', '>=', toTimestamp(from));

    if (filters.to) {
        query = query.where('createdAt', '<=', toTimestamp(filters.to));
    }

    const snapshot = await query.get();
    const sales = snapshot.docs.map((doc) => mapSale(doc.id, doc.data()));
    return filters.includeVoided ? sales : sales.filter((sale) => sale.voidedAt === null);
};

export const listSales = async (filters: {
    productId?: string;
    from?: string;
    to?: string;
    cashSessionId?: string;
    includeVoided?: boolean;
    /**
     * Acota la lectura de Firestore a los `maxDocs` documentos más recientes
     * (ordenados por `createdAt desc`) en vez de traer toda la ventana de
     * fechas. Solo es seguro pasarlo cuando ningún filtro posterior en
     * memoria (búsqueda de texto) necesita ver el rango completo para no
     * perder coincidencias fuera del recorte.
     */
    maxDocs?: number;
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

    if (filters.maxDocs !== undefined) {
        query = query.limit(filters.maxDocs);
    }

    const snapshot = await query.get();
    let sales = snapshot.docs.map((doc) => mapSale(doc.id, doc.data()));

    if (!filters.includeVoided) {
        sales = sales.filter((sale) => sale.voidedAt === null);
    }

    if (filters.productId) {
        sales = sales.filter((sale) =>
            sale.productIds?.includes(filters.productId!) ||
            sale.items.some(
                (item) => isSaleProductItem(item) && item.productId === filters.productId,
            ),
        );
    }

    return { items: sales, total: sales.length };
};
