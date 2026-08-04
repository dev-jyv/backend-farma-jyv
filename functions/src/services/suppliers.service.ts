import { Supplier } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as suppliersRepo from '../repositories/suppliers.repository';

export const listSuppliers = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Supplier[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await suppliersRepo.listSuppliers({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getSupplier = async (id: string): Promise<Supplier> => {
    const supplier = await suppliersRepo.getSupplierById(id);
    if (!supplier) {
        throw notFound('Proveedor');
    }
    return supplier;
};

export const createSupplier = async (input: {
    name: string;
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
    notes?: string;
}): Promise<Supplier> => {
    if (!input.name.trim()) {
        throw badRequest('El nombre es requerido');
    }

    return suppliersRepo.createSupplier({
        name: input.name.trim(),
        contactName: input.contactName?.trim(),
        email: input.email?.trim(),
        phone: input.phone?.trim(),
        address: input.address?.trim(),
        notes: input.notes?.trim(),
        isActive: true,
    });
};

export const updateSupplier = async (
    id: string,
    input: {
        name?: string;
        contactName?: string;
        email?: string;
        phone?: string;
        address?: string;
        notes?: string;
        isActive?: boolean;
    },
): Promise<Supplier> => {
    const existing = await suppliersRepo.getSupplierById(id);
    if (!existing) {
        throw notFound('Proveedor');
    }

    return suppliersRepo.updateSupplier(id, {
        name: input.name?.trim(),
        contactName: input.contactName?.trim(),
        email: input.email?.trim(),
        phone: input.phone?.trim(),
        address: input.address?.trim(),
        notes: input.notes?.trim(),
        isActive: input.isActive,
    });
};

export const deleteSupplier = async (id: string): Promise<Supplier> => {
    const existing = await suppliersRepo.getSupplierById(id);
    if (!existing) {
        throw notFound('Proveedor');
    }

    const [invoices, products] = await Promise.all([
        suppliersRepo.countInvoicesBySupplier(id),
        suppliersRepo.countActiveProductsBySupplier(id),
    ]);
    if (invoices > 0 || products > 0) {
        throw badRequest(
            'No se puede desactivar un proveedor con facturas o productos vinculados',
        );
    }

    return suppliersRepo.updateSupplier(id, { isActive: false });
};
