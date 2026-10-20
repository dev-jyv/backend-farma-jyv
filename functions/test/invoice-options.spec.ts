/** SPEC 05: lista ligera de facturas con saldo para los selectores. */

jest.mock('../src/utils/storage', () => ({
    getFileMetadata: jest.fn(async () => ({ fileName: 'f.pdf', mimeType: 'application/pdf' })),
    getFileUrl: jest.fn(async () => 'https://signed.example/f.pdf'),
}));

import * as invoicesService from '../src/services/invoices.service';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const isoDay = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const createSupplier = () => suppliersRepo.createSupplier({ name: unique('Prov'), isActive: true });
const createInvoice = (supplierId: string, overrides: Record<string, unknown> = {}) =>
    invoicesService.createInvoice({
        supplierId,
        invoiceNumber: unique('FAC'),
        invoiceDate: isoDay(-5),
        totalAmount: 1000,
        hasInvoice: false,
        userId: 'admin-user',
        ...overrides,
    });

describe('invoices/options', () => {
    it('devuelve solo facturas con saldo, con el saldo de settlementOf', async () => {
        const supplier = await createSupplier();
        const pending = await createInvoice(supplier.id);
        const partial = await createInvoice(supplier.id);
        await invoicesService.registerPayment(partial.id, {
            amount: 400, paymentMethod: 'cash', userId: 'admin-user', roleSlug: 'admin',
        });
        const paid = await createInvoice(supplier.id, { totalAmount: 300 });
        await invoicesService.registerPayment(paid.id, {
            amount: 300, paymentMethod: 'cash', userId: 'admin-user', roleSlug: 'admin',
        });
        // Anterior a cuentas por pagar: sin `paidTotal`, se da por saldada.
        const legacy = await createInvoice(supplier.id);
        await db().collection('invoices').doc(legacy.id).update({
            paidTotal: (await import('firebase-admin/firestore')).FieldValue.delete(),
        });

        const result = await invoicesService.listInvoiceOptions();
        const byId = new Map(result.items.map((item) => [item.id, item]));

        expect(byId.get(pending.id)).toMatchObject({
            invoiceNumber: pending.invoiceNumber, supplierId: supplier.id, balance: 1000,
        });
        expect(byId.get(partial.id)?.balance).toBe(600);
        expect(byId.has(paid.id)).toBe(false);
        expect(byId.has(legacy.id)).toBe(false);
        expect(result.truncated).toBe(false);
    });

    it('el mismo número en dos proveedores aparece dos veces, con su proveedor', async () => {
        const a = await createSupplier();
        const b = await createSupplier();
        const number = unique('DUP');
        await createInvoice(a.id, { invoiceNumber: number });
        await createInvoice(b.id, { invoiceNumber: number });

        const { items } = await invoicesService.listInvoiceOptions();
        const suppliers = items.filter((i) => i.invoiceNumber === number).map((i) => i.supplierId);
        expect(suppliers.sort()).toEqual([a.id, b.id].sort());
    });

    it('marca truncated cuando hay más que el máximo', async () => {
        const supplier = await createSupplier();
        await createInvoice(supplier.id);
        await createInvoice(supplier.id);

        const result = await invoicesService.listInvoiceOptions(1);
        expect(result.items).toHaveLength(1);
        expect(result.truncated).toBe(true);
        expect(result.total).toBeGreaterThan(1);
    });
});
