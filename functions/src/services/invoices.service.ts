import { Invoice, InvoiceWithDetails } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { assertFileExists, getFileMetadata, getFileUrl } from '../utils/storage';
import { toTimestamp } from '../utils/firestore';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';

const enrichInvoice = async (invoice: Invoice): Promise<InvoiceWithDetails> => {
    const supplier = await suppliersRepo.getSupplierById(invoice.supplierId);
    if (!supplier) {
        throw notFound('Proveedor');
    }

    const fileUrl = invoice.storagePath
        ? await getFileUrl(invoice.storagePath)
        : undefined;
    return { ...invoice, supplier, fileUrl };
};

export const listInvoices = async (filters: {
    supplierId?: string;
    from?: string;
    to?: string;
    hasInvoice?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: InvoiceWithDetails[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const invoices = await invoicesRepo.listInvoices(filters);
    let items = await Promise.all(invoices.map((invoice) => enrichInvoice(invoice)));

    if (filters.search) {
        const term = filters.search.toLowerCase();
        items = items.filter(
            (invoice) =>
                invoice.invoiceNumber.toLowerCase().includes(term) ||
                invoice.supplier.name.toLowerCase().includes(term),
        );
    }

    const paginated = paginate(items, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

export const getInvoice = async (id: string): Promise<InvoiceWithDetails> => {
    const invoice = await invoicesRepo.getInvoiceById(id);
    if (!invoice) {
        throw notFound('Factura');
    }
    return enrichInvoice(invoice);
};

export const createInvoice = async (input: {
    supplierId: string;
    invoiceNumber: string;
    invoiceDate: string;
    totalAmount: number;
    hasInvoice: boolean;
    fileUrl: string;
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

    const existing = await invoicesRepo.findInvoiceBySupplierAndNumber(
        input.supplierId,
        invoiceNumber,
    );
    if (existing) {
        throw badRequest('Ya existe una factura con ese número para este proveedor');
    }

    const storagePath = input.fileUrl;
    if (!storagePath.startsWith('uploads/')) {
        throw badRequest('La URL del archivo no es válida');
    }

    await assertFileExists(storagePath);
    const { fileName, mimeType } = await getFileMetadata(storagePath);

    const invoiceId = invoicesRepo.generateInvoiceId();
    const invoice = await invoicesRepo.createInvoice(
        invoiceId,
        {
            supplierId: input.supplierId,
            invoiceNumber,
            invoiceDate: toTimestamp(input.invoiceDate),
            totalAmount: input.totalAmount,
            hasInvoice: input.hasInvoice,
            storagePath,
            fileName,
            mimeType,
        },
        input.userId,
    );

    return enrichInvoice(invoice);
};
