import { Invoice } from '../types';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('invoices');

export const listInvoices = async (filters: {
    supplierId?: string;
    from?: string;
    to?: string;
    hasInvoice?: boolean;
}): Promise<Invoice[]> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.supplierId) {
        query = query.where('supplierId', '==', filters.supplierId);
    }

    query = query.orderBy('invoiceDate', 'desc');

    const snapshot = await query.get();
    let invoices = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            id: doc.id,
            ...data,
            hasInvoice: data.hasInvoice ?? Boolean(data.storagePath),
        } as Invoice;
    });

    if (filters.hasInvoice !== undefined) {
        invoices = invoices.filter((invoice) => invoice.hasInvoice === filters.hasInvoice);
    }

    if (filters.from) {
        const fromMs = new Date(filters.from).getTime();
        invoices = invoices.filter((invoice) => invoice.invoiceDate.toMillis() >= fromMs);
    }

    if (filters.to) {
        const toMs = new Date(filters.to).getTime();
        invoices = invoices.filter((invoice) => invoice.invoiceDate.toMillis() <= toMs);
    }

    return invoices;
};

export const getInvoiceById = async (id: string): Promise<Invoice | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    const data = doc.data()!;
    return {
        id: doc.id,
        ...data,
        hasInvoice: data.hasInvoice ?? Boolean(data.storagePath),
    } as Invoice;
};

export const findInvoiceBySupplierAndNumber = async (
    supplierId: string,
    invoiceNumber: string,
): Promise<Invoice | null> => {
    const snapshot = await collection()
        .where('supplierId', '==', supplierId)
        .where('invoiceNumber', '==', invoiceNumber)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Invoice;
};

export const createInvoice = async (
    id: string,
    data: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'>,
    userId: string,
): Promise<Invoice> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        createdBy: userId,
        updatedAt: timestamp,
        updatedBy: userId,
    };
    await collection().doc(id).set(payload);
    return { id, ...payload };
};

export const generateInvoiceId = (): string => collection().doc().id;
