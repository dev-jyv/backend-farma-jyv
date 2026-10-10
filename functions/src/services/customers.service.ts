import { Customer } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as customersRepo from '../repositories/customers.repository';

export const listCustomers = async (filters: {
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Customer[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await customersRepo.listCustomers({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getCustomer = async (id: string): Promise<Customer> => {
    const customer = await customersRepo.getCustomerById(id);
    if (!customer) {
        throw notFound('Cliente');
    }
    return customer;
};

export const createCustomer = async (input: {
    name: string;
    rfc?: string;
    phone?: string;
    email?: string;
}): Promise<Customer> => {
    if (!input.name.trim()) {
        throw badRequest('El nombre es requerido');
    }
    return customersRepo.createCustomer({
        name: input.name.trim(),
        rfc: input.rfc?.trim().toUpperCase(),
        phone: input.phone?.trim(),
        email: input.email?.trim(),
    });
};

export const updateCustomer = async (
    id: string,
    input: {
        name?: string;
        rfc?: string;
        phone?: string;
        email?: string;
    },
): Promise<Customer> => {
    const existing = await customersRepo.getCustomerById(id);
    if (!existing) {
        throw notFound('Cliente');
    }
    return customersRepo.updateCustomer(id, {
        name: input.name?.trim(),
        rfc: input.rfc?.trim().toUpperCase(),
        phone: input.phone?.trim(),
        email: input.email?.trim(),
    });
};
