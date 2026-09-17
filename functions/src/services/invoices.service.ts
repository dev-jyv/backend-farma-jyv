import {
    ExpensePaymentMethod,
    Invoice,
    InvoicePaymentStatus,
    InvoiceWithDetails,
    Supplier,
    SupplierPayment,
} from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { getFileMetadata, getFileUrl } from '../utils/storage';
import { toTimestamp } from '../utils/firestore';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';
import { assertPeriodOpen } from './accounting-core.service';
import { recordAudit } from './audit.service';

/** Tolerancia de un centavo, la misma con la que se valida el desglose. */
const CENT = 0.01;

/**
 * Saldo y estado de una factura, **derivados** del abonado. Ver
 * `InvoicePaymentStatus`: un estado almacenado se desincroniza, el saldo no.
 */
export const settlementOf = (
    invoice: Invoice,
    asOf: Date = new Date(),
): { paymentStatus: InvoicePaymentStatus; balance: number; isOverdue: boolean } => {
    // Sin `paidTotal` la factura es anterior a cuentas por pagar: se da por
    // saldada, y su saldo es cero para todos los efectos.
    if (invoice.paidTotal === undefined) {
        return { paymentStatus: 'legacy', balance: 0, isOverdue: false };
    }

    const balance = Math.round((invoice.totalAmount - invoice.paidTotal) * 100) / 100;
    const paymentStatus: InvoicePaymentStatus = balance <= CENT
        ? 'paid'
        : invoice.paidTotal > 0
            ? 'partial'
            : 'pending';

    // Vencida es una condición aparte del estado, no otro estado: una factura
    // puede estar abonada a medias **y** vencida, y meterlas en el mismo campo
    // obligaría a escoger cuál de las dos cosas se le esconde al que paga.
    const isOverdue = paymentStatus !== 'paid' &&
        invoice.dueDate !== undefined &&
        invoice.dueDate !== null &&
        invoice.dueDate.toDate() < asOf;

    return { paymentStatus, balance, isOverdue };
};

const enrichInvoice = async (
    invoice: Invoice,
    supplier: Supplier,
    includeFileUrl: boolean,
): Promise<InvoiceWithDetails> => {
    const fileUrl = includeFileUrl && invoice.storagePath
        ? await getFileUrl(invoice.storagePath)
        : undefined;
    return { ...invoice, supplier, fileUrl, ...settlementOf(invoice) };
};

const enrichInvoicesPage = async (
    invoices: Invoice[],
    includeFileUrl: boolean,
): Promise<InvoiceWithDetails[]> => {
    const suppliers = await suppliersRepo.getSuppliersByIds(
        invoices.map((invoice) => invoice.supplierId),
    );

    return Promise.all(
        invoices.map(async (invoice) => {
            const supplier = suppliers.get(invoice.supplierId);
            if (!supplier) {
                throw notFound('Proveedor');
            }
            return enrichInvoice(invoice, supplier, includeFileUrl);
        }),
    );
};

export const listInvoices = async (filters: {
    supplierId?: string;
    from?: string;
    to?: string;
    hasInvoice?: boolean;
    paymentStatus?: InvoicePaymentStatus | 'overdue';
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: InvoiceWithDetails[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    let invoices = await invoicesRepo.listInvoices({
        supplierId: filters.supplierId,
        from: filters.from,
        to: filters.to,
        hasInvoice: filters.hasInvoice,
    });

    if (filters.paymentStatus) {
        // En memoria y no en la consulta: el estado es derivado, así que no hay
        // campo por el cual filtrar en Firestore.
        const asOf = new Date();
        invoices = invoices.filter((invoice) => {
            const settlement = settlementOf(invoice, asOf);
            return filters.paymentStatus === 'overdue'
                ? settlement.isOverdue
                : settlement.paymentStatus === filters.paymentStatus;
        });
    }

    if (filters.search) {
        const term = filters.search.toLowerCase();
        const supplierIds = [...new Set(invoices.map((invoice) => invoice.supplierId))];
        const suppliers = await suppliersRepo.getSuppliersByIds(supplierIds);
        invoices = invoices.filter((invoice) => {
            const supplier = suppliers.get(invoice.supplierId);
            return (
                invoice.invoiceNumber.toLowerCase().includes(term) ||
                (supplier?.name.toLowerCase().includes(term) ?? false)
            );
        });
    }

    const paginated = paginate(invoices, page, limit);
    const items = await enrichInvoicesPage(paginated.items, false);

    return {
        items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

export const getInvoice = async (id: string): Promise<InvoiceWithDetails> => {
    const invoice = await invoicesRepo.getInvoiceById(id);
    if (!invoice) {
        throw notFound('Factura');
    }
    const supplier = await suppliersRepo.getSupplierById(invoice.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }
    return enrichInvoice(invoice, supplier, true);
};

export const createInvoice = async (input: {
    supplierId: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate?: string;
    totalAmount: number;
    taxes?: { subtotal: number; ivaAmount: number; iepsAmount: number };
    hasInvoice: boolean;
    fileUrl?: string;
    userId: string;
}): Promise<InvoiceWithDetails> => {
    const supplier = await suppliersRepo.getSupplierById(input.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }
    if (!supplier.isActive) {
        throw badRequest('El proveedor no está activo');
    }

    const invoiceNumber = input.invoiceNumber.trim();
    if (!invoiceNumber) {
        throw badRequest('El número de factura es requerido');
    }

    const invoiceDate = new Date(input.invoiceDate);
    if (Number.isNaN(invoiceDate.getTime())) {
        throw badRequest('Fecha de factura inválida');
    }

    /**
     * El comprobante es opcional: la factura se registra aunque el archivo
     * llegue después. Los tres campos del archivo viajan juntos o no viajan —
     * escribir `undefined` en Firestore es un error de escritura, no un campo
     * vacío, así que se omiten en vez de asignarse.
     */
    const archivo: Pick<Invoice, 'storagePath' | 'fileName' | 'mimeType'> | undefined =
        await (async () => {
            const storagePath = input.fileUrl;
            if (!storagePath) {
                return undefined;
            }
            // Mismo ancla que el schema, repetido a propósito: el schema cubre
            // HTTP, no a otros llamadores del servicio.
            if (!storagePath.startsWith('facturas/') && !storagePath.startsWith('uploads/')) {
                throw badRequest('La ruta del archivo no es válida');
            }
            // `getFileMetadata` rechaza el archivo inexistente: una llamada, no dos.
            const { fileName, mimeType } = await getFileMetadata(storagePath);
            return { storagePath, fileName, mimeType };
        })();

    const invoiceId = invoicesRepo.generateInvoiceId();
    const invoice = await invoicesRepo.createInvoice(
        invoiceId,
        {
            supplierId: input.supplierId,
            invoiceNumber,
            invoiceDate: toTimestamp(input.invoiceDate),
            ...(input.dueDate ? { dueDate: toTimestamp(input.dueDate) } : {}),
            totalAmount: input.totalAmount,
            ...(input.taxes ? { taxes: input.taxes } : {}),
            /**
             * Toda factura nueva nace con saldo. Es lo que separa a las facturas
             * con control de pago de las `legacy`: las anteriores a este módulo
             * no tienen el campo y se dan por saldadas, sin migración de datos
             * ni fecha de corte que alguien tenga que recordar.
             */
            paidTotal: 0,
            hasInvoice: input.hasInvoice,
            ...archivo,
        },
        input.userId,
    );

    return enrichInvoice(invoice, supplier, true);
};

/**
 * Registra un abono a una factura de proveedor.
 *
 * Se audita: es dinero que sale de la farmacia, igual que un gasto. La factura
 * en sí sigue siendo de solo alta —aquí no se corrige su importe ni su folio—;
 * lo que se agrega es un renglón nuevo, y el saldo es su consecuencia.
 */
export const registerPayment = async (
    invoiceId: string,
    input: {
        amount: number;
        paymentMethod: ExpensePaymentMethod;
        paidAt?: string;
        reference?: string;
        notes?: string;
        bankAccountId?: string;
        userId: string;
        roleSlug: string;
        userLabel?: string;
    },
): Promise<{ payment: SupplierPayment; invoice: InvoiceWithDetails }> => {
    // El abono se fecha a mano y mueve el saldo del periodo: no puede caer en
    // uno ya cerrado.
    await assertPeriodOpen(input.paidAt ? new Date(input.paidAt) : new Date(), 'Abono');

    const { payment, invoice } = await invoicesRepo.registerPayment(invoiceId, {
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        ...(input.paidAt ? { paidAt: new Date(input.paidAt) } : {}),
        ...(input.reference ? { reference: input.reference.trim() } : {}),
        ...(input.notes ? { notes: input.notes.trim() } : {}),
        ...(input.bankAccountId ? { bankAccountId: input.bankAccountId } : {}),
        createdBy: input.userId,
        ...(input.userLabel ? { createdByLabel: input.userLabel } : {}),
    });

    const supplier = await suppliersRepo.getSupplierById(invoice.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }
    const enriched = await enrichInvoice(invoice, supplier, false);

    await recordAudit({
        action: 'supplierPayment.created',
        entity: 'supplierPayment',
        entityId: payment.id,
        summary: `Abono de ${input.amount.toFixed(2)} a la factura ` +
            `${invoice.invoiceNumber} de ${supplier.name} (${input.paymentMethod}); ` +
            `saldo ${enriched.balance.toFixed(2)}`,
        userId: input.userId,
        roleSlug: input.roleSlug,
        metadata: {
            invoiceId,
            amount: input.amount,
            paymentMethod: input.paymentMethod,
            balance: enriched.balance,
        },
    });

    return { payment, invoice: enriched };
};

/**
 * Corrige vencimiento y desglose de una factura ya registrada. El desglose tiene
 * que seguir sumando el total: un desglose que no cuadra da un IVA acreditable
 * que Hacienda no reconocería, y aquí se está tocando una factura que ya pasó
 * por esa validación al darse de alta.
 */
export const updateAccounting = async (
    invoiceId: string,
    input: {
        dueDate?: string | null;
        taxes?: { subtotal: number; ivaAmount: number; iepsAmount: number } | null;
        userId: string;
        roleSlug: string;
    },
): Promise<InvoiceWithDetails> => {
    const invoice = await invoicesRepo.getInvoiceById(invoiceId);
    if (!invoice) {
        throw notFound('Factura');
    }

    if (input.taxes) {
        const suma = input.taxes.subtotal + input.taxes.ivaAmount + input.taxes.iepsAmount;
        if (Math.abs(suma - invoice.totalAmount) > CENT) {
            throw badRequest('El desglose de impuestos no suma el total de la factura');
        }
    }
    if (input.dueDate && new Date(input.dueDate) < invoice.invoiceDate.toDate()) {
        throw badRequest('El vencimiento no puede ser anterior a la factura');
    }

    const updated = await invoicesRepo.updateInvoiceAccounting(
        invoiceId,
        {
            ...(input.dueDate !== undefined
                ? { dueDate: input.dueDate ? new Date(input.dueDate) : null }
                : {}),
            ...(input.taxes !== undefined ? { taxes: input.taxes } : {}),
        },
        input.userId,
    );

    const supplier = await suppliersRepo.getSupplierById(updated.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }

    await recordAudit({
        action: 'invoice.updated',
        entity: 'invoice',
        entityId: invoiceId,
        summary: `Factura ${updated.invoiceNumber} corregida: ` +
            (input.dueDate !== undefined ? 'vencimiento' : '') +
            (input.dueDate !== undefined && input.taxes !== undefined ? ' y ' : '') +
            (input.taxes !== undefined ? 'desglose de impuestos' : ''),
        userId: input.userId,
        roleSlug: input.roleSlug,
        metadata: { dueDate: input.dueDate ?? null, taxes: input.taxes ?? null },
    });

    return enrichInvoice(updated, supplier, false);
};

/** Cancela un abono con su contrapartida; ver `invoicesRepo.voidPayment`. */
export const voidPayment = async (
    paymentId: string,
    input: { reason: string; userId: string; roleSlug: string; userLabel?: string },
): Promise<{ reversal: SupplierPayment; invoice: InvoiceWithDetails }> => {
    const { reversal, invoice } = await invoicesRepo.voidPayment(paymentId, {
        reason: input.reason.trim(),
        userId: input.userId,
        ...(input.userLabel ? { userLabel: input.userLabel } : {}),
    });

    const supplier = await suppliersRepo.getSupplierById(invoice.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }
    const enriched = await enrichInvoice(invoice, supplier, false);

    await recordAudit({
        action: 'supplierPayment.voided',
        entity: 'supplierPayment',
        entityId: paymentId,
        summary: `Abono de ${Math.abs(reversal.amount).toFixed(2)} cancelado en la factura ` +
            `${invoice.invoiceNumber}: ${input.reason.trim()}; ` +
            `saldo ${enriched.balance.toFixed(2)}`,
        userId: input.userId,
        roleSlug: input.roleSlug,
        metadata: { invoiceId: invoice.id, reversalId: reversal.id, reason: input.reason },
    });

    return { reversal, invoice: enriched };
};

export const listPayments = async (invoiceId: string): Promise<SupplierPayment[]> => {
    const invoice = await invoicesRepo.getInvoiceById(invoiceId);
    if (!invoice) {
        throw notFound('Factura');
    }
    return invoicesRepo.listPaymentsForInvoice(invoiceId);
};
