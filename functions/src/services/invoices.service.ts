import { Invoice, InvoiceWithDetails, Supplier } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { getFileMetadata, getFileUrl } from '../utils/storage';
import { toTimestamp } from '../utils/firestore';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';

const enrichInvoice = async (
    invoice: Invoice,
    supplier: Supplier,
    includeFileUrl: boolean,
): Promise<InvoiceWithDetails> => {
    const fileUrl = includeFileUrl && invoice.storagePath
        ? await getFileUrl(invoice.storagePath)
        : undefined;
    return { ...invoice, supplier, fileUrl };
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
    totalAmount: number;
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
            totalAmount: input.totalAmount,
            hasInvoice: input.hasInvoice,
            ...archivo,
        },
        input.userId,
    );

    return enrichInvoice(invoice, supplier, true);
};
