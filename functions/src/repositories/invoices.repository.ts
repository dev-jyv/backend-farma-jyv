import { Invoice } from '../types';
import { db, now, toTimestamp } from '../utils/firestore';
import { conflict } from '../utils/errors';

const collection = () => db().collection('invoices');

const mapInvoice = (doc: FirebaseFirestore.DocumentSnapshot): Invoice => {
    const data = doc.data()!;
    return {
        id: doc.id,
        ...data,
        hasInvoice: data.hasInvoice ?? Boolean(data.storagePath),
    } as Invoice;
};

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

    if (filters.hasInvoice !== undefined) {
        query = query.where('hasInvoice', '==', filters.hasInvoice);
    }

    if (filters.from) {
        query = query.where('invoiceDate', '>=', toTimestamp(filters.from));
    }

    if (filters.to) {
        query = query.where('invoiceDate', '<=', toTimestamp(filters.to));
    }

    query = query.orderBy('invoiceDate', 'desc');

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => mapInvoice(doc));
};

export const getInvoiceById = async (id: string): Promise<Invoice | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapInvoice(doc);
};

export const createInvoice = async (
    id: string,
    data: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'>,
    userId: string,
): Promise<Invoice> => {
    const firestore = db();
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        createdBy: userId,
        updatedAt: timestamp,
        updatedBy: userId,
    };

    await firestore.runTransaction(async (transaction) => {
        const existingSnap = await transaction.get(
            collection()
                .where('supplierId', '==', data.supplierId)
                .where('invoiceNumber', '==', data.invoiceNumber)
                .limit(1),
        );
        if (!existingSnap.empty) {
            throw conflict('Ya existe una factura con ese número para este proveedor');
        }
        transaction.set(collection().doc(id), payload);
    });

    return { id, ...payload };
};

export const generateInvoiceId = (): string => collection().doc().id;
