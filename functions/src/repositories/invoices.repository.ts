import { Invoice, SupplierPayment } from '../types';
import { db, fromDate, now, toTimestamp } from '../utils/firestore';
import { badRequest, conflict, notFound } from '../utils/errors';

const collection = () => db().collection('invoices');

const paymentsCollection = () => db().collection('supplierPayments');

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

/**
 * Facturas que **sí** llevan control de saldo, para cuentas por pagar.
 *
 * El `orderBy('paidTotal')` no es cosmético: Firestore excluye de un `orderBy`
 * los documentos que no tienen el campo, y eso es justo lo que se busca —las
 * facturas anteriores a cuentas por pagar (`legacy`) se dan por saldadas y no
 * deben aparecer como deuda—. El saldo se filtra después en memoria porque
 * Firestore no compara dos campos del mismo documento (`paidTotal < totalAmount`).
 */
export const listTrackedInvoices = async (): Promise<Invoice[]> => {
    const snapshot = await collection().orderBy('paidTotal').get();
    return snapshot.docs.map((doc) => mapInvoice(doc));
};

/**
 * Corrige los datos **contables** de una factura: vencimiento y desglose de
 * impuestos. Nada más. El folio, el proveedor y el importe siguen siendo de solo
 * alta: cambiarlos reescribiría el documento que la factura representa, mientras
 * que estos dos campos son captura que puede llegar después del alta.
 */
export const updateInvoiceAccounting = async (
    id: string,
    patch: {
        dueDate?: Date | null;
        taxes?: Invoice['taxes'];
    },
    userId: string,
): Promise<Invoice> => {
    const data: Record<string, unknown> = { updatedAt: now(), updatedBy: userId };
    if (patch.dueDate !== undefined) {
        data.dueDate = patch.dueDate ? fromDate(patch.dueDate) : null;
    }
    if (patch.taxes !== undefined) {
        data.taxes = patch.taxes ?? null;
    }

    const ref = collection().doc(id);
    await ref.update(data);
    return mapInvoice(await ref.get());
};

/**
 * Cancela un abono con una **contrapartida**: guarda un segundo abono por el
 * importe en negativo y marca el original como cancelado. No se borra nada.
 *
 * Borrar el renglón dejaría una factura cuyo saldo subió sin que nada explique
 * por qué; la contrapartida deja las dos mitades a la vista, que es como se
 * corrige dinero ya registrado.
 */
export const voidPayment = async (
    paymentId: string,
    input: { reason: string; userId: string; userLabel?: string },
): Promise<{ reversal: SupplierPayment; invoice: Invoice }> => {
    const firestore = db();
    const paymentRef = paymentsCollection().doc(paymentId);
    const reversalRef = paymentsCollection().doc();
    const timestamp = now();

    return firestore.runTransaction(async (transaction) => {
        const paymentDoc = await transaction.get(paymentRef);
        if (!paymentDoc.exists) {
            throw notFound('Abono');
        }
        const payment = { id: paymentDoc.id, ...paymentDoc.data() } as SupplierPayment;

        if (payment.voidedAt) {
            throw badRequest('Este abono ya fue cancelado');
        }
        if (payment.amount < 0) {
            throw badRequest('Una contrapartida no se cancela: cancela el abono original');
        }

        const invoiceRef = collection().doc(payment.invoiceId);
        const invoiceDoc = await transaction.get(invoiceRef);
        if (!invoiceDoc.exists) {
            throw notFound('Factura');
        }
        const invoice = mapInvoice(invoiceDoc);
        const paidTotal = Math.round(((invoice.paidTotal ?? 0) - payment.amount) * 100) / 100;

        const reversal = {
            invoiceId: payment.invoiceId,
            supplierId: payment.supplierId,
            amount: -payment.amount,
            paymentMethod: payment.paymentMethod,
            // El reverso se fecha **hoy**, no en la fecha del abono cancelado: el
            // dinero regresa cuando se corrige, y antedatarlo movería el saldo de
            // un periodo que pudo haberse reportado ya.
            paidAt: timestamp,
            reference: null,
            notes: input.reason,
            // La contrapartida vuelve a la **misma cuenta** de la que salió el
            // dinero. Sin esto el saldo bancario se quedaba bajo para siempre:
            // el abono lo descontó y su reverso no se lo devolvía a nadie.
            bankAccountId: payment.bankAccountId ?? null,
            createdBy: input.userId,
            createdByLabel: input.userLabel ?? null,
            createdAt: timestamp,
            voidsPaymentId: paymentId,
        };

        transaction.set(reversalRef, reversal);
        transaction.update(paymentRef, {
            voidedAt: timestamp,
            voidedBy: input.userId,
            voidReason: input.reason,
        });
        transaction.update(invoiceRef, {
            paidTotal,
            updatedAt: timestamp,
            updatedBy: input.userId,
        });

        return {
            reversal: { id: reversalRef.id, ...reversal },
            invoice: { ...invoice, paidTotal },
        };
    });
};

/** Abonos por fecha de pago; para el flujo de efectivo del balance. */
export const listPaymentsForPeriod = async (filters: {
    from?: Date;
    to: Date;
}): Promise<SupplierPayment[]> => {
    let query = paymentsCollection().orderBy('paidAt', 'desc') as FirebaseFirestore.Query;
    if (filters.from) {
        query = query.where('paidAt', '>=', fromDate(filters.from));
    }
    query = query.where('paidAt', '<=', fromDate(filters.to));
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as SupplierPayment);
};

export const listPaymentsForInvoice = async (
    invoiceId: string,
): Promise<SupplierPayment[]> => {
    const snapshot = await paymentsCollection()
        .where('invoiceId', '==', invoiceId)
        .get();
    const payments = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() }) as SupplierPayment,
    );
    // Orden en memoria: ordenar por `paidAt` en la consulta exigiría un índice
    // compuesto con `invoiceId`, y una factura no tiene tantos abonos.
    return payments.sort((a, b) => b.paidAt.toMillis() - a.paidAt.toMillis());
};

/**
 * Registra un abono y actualiza el saldo de la factura **en una transacción**.
 *
 * Las dos escrituras van juntas a propósito: un abono guardado sin su efecto en
 * `paidTotal` deja una factura que se ve pendiente y ya está pagada, y el saldo
 * actualizado sin el abono deja dinero sin rastro de a quién se le dio. La
 * lectura de la factura ocurre dentro de la transacción, así que dos abonos
 * simultáneos no pueden sobregirar la factura: el segundo reintenta contra el
 * saldo ya actualizado.
 */
export const registerPayment = async (
    invoiceId: string,
    input: {
        amount: number;
        paymentMethod: SupplierPayment['paymentMethod'];
        paidAt?: Date;
        reference?: string;
        notes?: string;
        /** Cuenta de la que salió el pago, cuando no fue en efectivo. */
        bankAccountId?: string;
        createdBy: string;
        createdByLabel?: string;
    },
): Promise<{ payment: SupplierPayment; invoice: Invoice }> => {
    const firestore = db();
    const invoiceRef = collection().doc(invoiceId);
    const paymentRef = paymentsCollection().doc();
    const timestamp = now();

    return firestore.runTransaction(async (transaction) => {
        const invoiceDoc = await transaction.get(invoiceRef);
        if (!invoiceDoc.exists) {
            throw notFound('Factura');
        }
        const invoice = mapInvoice(invoiceDoc);

        // `legacy` (sin `paidTotal`) se da por saldada; abonarle sería registrar
        // un pago contra una deuda que este módulo declaró inexistente.
        if (invoice.paidTotal === undefined) {
            throw badRequest(
                'Esta factura es anterior a cuentas por pagar y se dio por saldada',
            );
        }

        const balance = invoice.totalAmount - invoice.paidTotal;
        // Un centavo de tolerancia, el mismo que valida el desglose: el abono
        // que cierra la factura no tiene por qué caer al céntimo exacto.
        if (input.amount > balance + 0.01) {
            throw badRequest(
                `El abono supera el saldo de la factura (${balance.toFixed(2)})`,
            );
        }

        const paidAt = input.paidAt ? fromDate(input.paidAt) : timestamp;
        const payment = {
            invoiceId,
            supplierId: invoice.supplierId,
            amount: input.amount,
            paymentMethod: input.paymentMethod,
            paidAt,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            bankAccountId: input.paymentMethod === 'cash'
                ? null
                : (input.bankAccountId ?? null),
            createdBy: input.createdBy,
            createdByLabel: input.createdByLabel ?? null,
            createdAt: timestamp,
        };

        // Redondeo a centavos: sumar flotantes abono tras abono deja un saldo de
        // 0.0000001 que nunca llega a "pagada".
        const paidTotal = Math.round((invoice.paidTotal + input.amount) * 100) / 100;

        transaction.set(paymentRef, payment);
        transaction.update(invoiceRef, {
            paidTotal,
            lastPaymentAt: paidAt,
            updatedAt: timestamp,
            updatedBy: input.createdBy,
        });

        return {
            payment: { id: paymentRef.id, ...payment },
            invoice: { ...invoice, paidTotal, lastPaymentAt: paidAt },
        };
    });
};
