/**
 * Marcador `outstanding` (SPEC 13): cuentas por pagar y el pasivo del balance
 * leen solo facturas y gastos devengados con saldo, no todo el historial.
 */

jest.mock('../src/utils/storage', () => ({
    getFileMetadata: jest.fn(async () => ({ fileName: 'f.pdf', mimeType: 'application/pdf' })),
    getFileUrl: jest.fn(async () => 'https://signed.example/f.pdf'),
}));

import * as accountingCore from '../src/services/accounting-core.service';
import * as accountingService from '../src/services/accounting.service';
import * as accruedRepo from '../src/repositories/accrued-expenses.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as invoicesService from '../src/services/invoices.service';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { backfillCollection, TARGETS } from '../src/scripts/backfill-outstanding';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const isoDay = (offset: number): string =>
    new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const supplier = () => suppliersRepo.createSupplier({ name: unique('Prov'), isActive: true });

const invoice = async (supplierId: string, totalAmount: number) =>
    invoicesService.createInvoice({
        supplierId,
        invoiceNumber: unique('FAC'),
        invoiceDate: isoDay(-5),
        totalAmount,
        hasInvoice: false,
        userId: 'admin-user',
    });

const flag = async (id: string) =>
    (await db().collection('invoices').doc(id).get()).get('outstanding');

const pay = (invoiceId: string, amount: number) =>
    invoicesService.registerPayment(invoiceId, {
        amount,
        paymentMethod: 'cash',
        userId: 'admin-user',
        roleSlug: 'admin',
    });

describe('invoices.outstanding', () => {
    it('una factura nueva nace con saldo y se marca pendiente', async () => {
        const s = await supplier();
        const created = await invoice(s.id, 500);
        expect(await flag(created.id)).toBe(true);
    });

    it('un abono parcial la deja pendiente; el que salda la desmarca', async () => {
        const s = await supplier();
        const created = await invoice(s.id, 500);

        await pay(created.id, 200);
        expect(await flag(created.id)).toBe(true);

        await pay(created.id, 300);
        expect(await flag(created.id)).toBe(false);
    });

    it('anular el abono que la saldó la vuelve a marcar', async () => {
        const s = await supplier();
        const created = await invoice(s.id, 500);
        const { payment } = await pay(created.id, 500);
        expect(await flag(created.id)).toBe(false);

        await invoicesService.voidPayment(payment.id, {
            reason: 'error de captura',
            userId: 'admin-user',
            roleSlug: 'admin',
        });
        expect(await flag(created.id)).toBe(true);
    });

    it('cuentas por pagar lee solo las facturas con saldo', async () => {
        const s = await supplier();
        const paid = await invoice(s.id, 100);
        await pay(paid.id, 100);
        const open = await invoice(s.id, 250);

        const listed = await invoicesRepo.listOutstandingInvoices();
        const ids = listed.map((i) => i.id);
        expect(ids).toContain(open.id);
        expect(ids).not.toContain(paid.id);

        const report = await accountingService.getPayables();
        const reported = report.invoices.map((i) => i.id);
        expect(reported).toContain(open.id);
        expect(reported).not.toContain(paid.id);
    });

    it('una factura anterior al módulo (sin paidTotal) no aparece como deuda', async () => {
        const s = await supplier();
        const legacy = await db().collection('invoices').add({
            supplierId: s.id,
            invoiceNumber: unique('LEG'),
            totalAmount: 999,
            invoiceDate: new Date(),
            hasInvoice: false,
        });
        const ids = (await invoicesRepo.listOutstandingInvoices()).map((i) => i.id);
        expect(ids).not.toContain(legacy.id);
    });
});

describe('accruedExpenses.outstanding', () => {
    const accrue = (amount: number) =>
        accountingCore.createAccruedExpense(
            { category: 'rent', concept: unique('Renta'), amount, accruedAt: isoDay(-3) },
            'admin-user',
            'admin',
        );

    it('nace pendiente, el pago total la desmarca y el pasivo suma las pendientes', async () => {
        const open = await accrue(700);
        const paid = await accrue(300);
        await accountingCore.payAccruedExpense(
            paid.id,
            { amount: 300, paymentMethod: 'cash', paidAt: isoDay(-1) },
            'admin-user',
            'admin',
        );

        const read = async (id: string) =>
            (await db().collection('accruedExpenses').doc(id).get()).get('outstanding');
        expect(await read(open.id)).toBe(true);
        expect(await read(paid.id)).toBe(false);

        const ids = (await accruedRepo.listOutstandingAccrued()).map((a) => a.id);
        expect(ids).toContain(open.id);
        expect(ids).not.toContain(paid.id);
        expect(await accountingCore.getAccruedTotal()).toBeGreaterThanOrEqual(700);
    });
});

describe('backfill:outstanding', () => {
    const invoiceTarget = TARGETS.find((t) => t.collection === 'invoices')!;

    it('el dry-run no escribe y la corrida real marca lo que falta, idempotente', async () => {
        const s = await supplier();
        const unmarked = await db().collection('invoices').add({
            supplierId: s.id,
            invoiceNumber: unique('SIN'),
            totalAmount: 400,
            paidTotal: 100,
            invoiceDate: new Date(),
            hasInvoice: false,
        });
        const settled = await db().collection('invoices').add({
            supplierId: s.id,
            invoiceNumber: unique('SAL'),
            totalAmount: 400,
            paidTotal: 400,
            invoiceDate: new Date(),
            hasInvoice: false,
        });

        const dry = await backfillCollection(invoiceTarget, true);
        expect(dry.missing).toBeGreaterThanOrEqual(2);
        expect(dry.written).toBe(0);
        expect((await unmarked.get()).get('outstanding')).toBeUndefined();

        await backfillCollection(invoiceTarget, false);
        expect((await unmarked.get()).get('outstanding')).toBe(true);
        expect((await settled.get()).get('outstanding')).toBe(false);

        const again = await backfillCollection(invoiceTarget, false);
        expect(again.missing).toBe(0);
        expect(again.written).toBe(0);
    });
});
