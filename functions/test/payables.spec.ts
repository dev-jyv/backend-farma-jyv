/**
 * Cuentas por pagar e IVA acreditable.
 *
 * Dos reglas cargan con casi todo el peso del módulo y por eso se fijan aquí:
 *
 * 1. Las facturas **anteriores** a cuentas por pagar (sin `paidTotal`) se dan
 *    por saldadas. Si se leyeran como pendientes, el día del despliegue
 *    aparecería una deuda falsa del tamaño de todo lo comprado en la historia
 *    del sistema.
 * 2. El abono y el saldo se escriben **juntos**, en transacción. Un abono sin su
 *    efecto en el saldo deja una factura pagada que se ve pendiente; el saldo
 *    sin el abono deja dinero sin rastro de a quién se le dio.
 */

jest.mock('../src/utils/storage', () => ({
    getFileMetadata: jest.fn(async () => ({
        fileName: 'factura.pdf',
        mimeType: 'application/pdf',
    })),
    getFileUrl: jest.fn(async () => 'https://signed.example/factura.pdf'),
}));

import * as accountingService from '../src/services/accounting.service';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as invoicesService from '../src/services/invoices.service';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { createInvoiceSchema } from '../src/schemas/inventory';
import { db, toTimestamp } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const isoDay = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const createSupplier = async () =>
    suppliersRepo.createSupplier({ name: unique('Proveedor'), isActive: true });

const createInvoice = async (
    supplierId: string,
    overrides: Partial<Parameters<typeof invoicesService.createInvoice>[0]> = {},
) =>
    invoicesService.createInvoice({
        supplierId,
        invoiceNumber: unique('FAC'),
        invoiceDate: isoDay(-5),
        totalAmount: 1160,
        hasInvoice: false,
        userId: 'admin-user',
        ...overrides,
    });

describe('createInvoiceSchema: vencimiento y desglose', () => {
    const base = {
        supplierId: 's-1',
        invoiceNumber: 'A-100',
        invoiceDate: '2026-09-05',
        totalAmount: 1160,
        hasInvoice: true,
    };

    it('acepta el desglose que suma el total', () => {
        const resultado = createInvoiceSchema.safeParse({
            ...base,
            dueDate: '2026-10-05',
            taxes: { subtotal: 1000, ivaAmount: 160, iepsAmount: 0 },
        });

        expect(resultado.success).toBe(true);
    });

    it('rechaza el desglose que no cuadra con la factura', () => {
        // Un desglose que no suma da un IVA acreditable que Hacienda no
        // reconocería, y nadie lo notaría hasta la declaración.
        const resultado = createInvoiceSchema.safeParse({
            ...base,
            taxes: { subtotal: 1000, ivaAmount: 100, iepsAmount: 0 },
        });

        expect(resultado.success).toBe(false);
    });

    it('rechaza un vencimiento anterior a la propia factura', () => {
        const resultado = createInvoiceSchema.safeParse({
            ...base,
            dueDate: '2026-09-01',
        });

        expect(resultado.success).toBe(false);
    });

    it('sigue aceptando la factura sin plazo ni desglose', () => {
        expect(createInvoiceSchema.safeParse(base).success).toBe(true);
    });
});

describe('facturas: saldo y abonos', () => {
    it('nace pendiente por el total y con saldo completo', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id);

        expect(invoice.paidTotal).toBe(0);
        expect(invoice.balance).toBe(1160);
        expect(invoice.paymentStatus).toBe('pending');
        expect(invoice.isOverdue).toBe(false);
    });

    it('el abono parcial baja el saldo y deja la factura en abonada', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id);

        const { invoice: afterPayment } = await invoicesService.registerPayment(invoice.id, {
            amount: 160,
            paymentMethod: 'transfer',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(afterPayment.paidTotal).toBe(160);
        expect(afterPayment.balance).toBe(1000);
        expect(afterPayment.paymentStatus).toBe('partial');

        const payments = await invoicesService.listPayments(invoice.id);
        expect(payments).toHaveLength(1);
        expect(payments[0].amount).toBe(160);
        expect(payments[0].paymentMethod).toBe('transfer');
    });

    it('el abono que cubre el saldo la deja pagada', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id, { totalAmount: 500 });

        await invoicesService.registerPayment(invoice.id, {
            amount: 200,
            paymentMethod: 'cash',
            userId: 'admin-user',
            roleSlug: 'admin',
        });
        const { invoice: settled } = await invoicesService.registerPayment(invoice.id, {
            amount: 300,
            paymentMethod: 'transfer',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(settled.paidTotal).toBe(500);
        expect(settled.balance).toBe(0);
        expect(settled.paymentStatus).toBe('paid');
    });

    it('rechaza el abono que sobregira la factura', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id, { totalAmount: 100 });

        await expect(
            invoicesService.registerPayment(invoice.id, {
                amount: 150,
                paymentMethod: 'cash',
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('supera el saldo'),
        });

        // Y no deja rastro a medias: sin transacción, el abono habría quedado
        // escrito aunque el saldo no se pudiera actualizar.
        expect(await invoicesService.listPayments(invoice.id)).toHaveLength(0);
    });

    it('la factura anterior al módulo se da por saldada y no admite abonos', async () => {
        const supplier = await createSupplier();
        // Documento sin `paidTotal`, tal como lo dejó el sistema antes de
        // cuentas por pagar.
        const ref = db().collection('invoices').doc();
        await ref.set({
            supplierId: supplier.id,
            invoiceNumber: unique('VIEJA'),
            invoiceDate: toTimestamp(isoDay(-200)),
            totalAmount: 9999,
            hasInvoice: false,
            createdAt: toTimestamp(isoDay(-200)),
            createdBy: 'legacy',
            updatedAt: toTimestamp(isoDay(-200)),
            updatedBy: 'legacy',
        });

        const invoice = await invoicesService.getInvoice(ref.id);
        expect(invoice.paymentStatus).toBe('legacy');
        expect(invoice.balance).toBe(0);

        await expect(
            invoicesService.registerPayment(ref.id, {
                amount: 10,
                paymentMethod: 'cash',
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('la consulta de saldos deja fuera a las facturas anteriores al módulo', async () => {
        const tracked = await invoicesRepo.listTrackedInvoices();

        // `orderBy('paidTotal')` excluye los documentos sin el campo; si eso
        // cambiara, aquí aparecería una factura `legacy` como deuda viva.
        expect(tracked.every((invoice) => invoice.paidTotal !== undefined)).toBe(true);
    });
});

describe('cuentas por pagar', () => {
    it('clasifica el saldo por antigüedad y lo agrupa por proveedor', async () => {
        const supplier = await createSupplier();
        await createInvoice(supplier.id, {
            totalAmount: 1000,
            invoiceDate: isoDay(-60),
            dueDate: isoDay(-45),
        });
        await createInvoice(supplier.id, {
            totalAmount: 500,
            invoiceDate: isoDay(-2),
            dueDate: isoDay(20),
        });

        const report = await accountingService.getPayables();
        const mine = report.bySupplier.find((row) => row.supplierId === supplier.id);

        expect(mine).toBeDefined();
        expect(mine!.total).toBeCloseTo(1500, 2);
        expect(mine!.overdueTotal).toBeCloseTo(1000, 2);
        expect(mine!.invoiceCount).toBe(2);

        const vencida = report.invoices.find(
            (row) => row.supplierId === supplier.id && row.isOverdue,
        );
        expect(vencida!.bucket).toBe('d31_60');
        expect(vencida!.daysOverdue).toBeGreaterThanOrEqual(45);

        const porVencer = report.invoices.find(
            (row) => row.supplierId === supplier.id && !row.isOverdue,
        );
        expect(porVencer!.bucket).toBe('current');
        // Sin atraso no hay días vencidos: un número negativo en esa columna se
        // lee como un error de cálculo.
        expect(porVencer!.daysOverdue).toBeNull();
    });

    it('la factura sin plazo pactado se separa de la que está al corriente', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id, { totalAmount: 700 });

        const report = await accountingService.getPayables();
        const row = report.invoices.find((item) => item.id === invoice.id);

        expect(row!.bucket).toBe('noDueDate');
        expect(row!.isOverdue).toBe(false);
    });

    it('la factura pagada sale del saldo', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id, { totalAmount: 300 });
        await invoicesService.registerPayment(invoice.id, {
            amount: 300,
            paymentMethod: 'transfer',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const report = await accountingService.getPayables();
        expect(report.invoices.some((row) => row.id === invoice.id)).toBe(false);
    });
});

describe('IVA acreditable', () => {
    it('sale del desglose de las compras y se resta al trasladado', async () => {
        const supplier = await createSupplier();
        const invoiceDate = isoDay(-3);
        const invoice = await createInvoice(supplier.id, {
            invoiceDate,
            totalAmount: 1160,
            taxes: { subtotal: 1000, ivaAmount: 160, iepsAmount: 0 },
        });

        // Ventana del ancho de esta factura: el emulador es compartido entre
        // suites y una ventana de días traería las compras de las otras.
        const instant = invoice.invoiceDate.toDate().toISOString();
        const statement = await accountingService.getIncomeStatement({
            from: instant,
            to: instant,
        });

        expect(statement.taxes.ivaCreditable).toBeCloseTo(160, 2);
        // Sin ventas en la ventana, el IVA por pagar sale a favor del negocio.
        expect(statement.taxes.ivaPayable).toBeCloseTo(-160, 2);
        expect(statement.reliability.invoicesWithoutTaxBreakdown).toBe(0);
    });

    it('la compra sin desglose se cuenta como hueco, no como cero silencioso', async () => {
        const supplier = await createSupplier();
        const invoice = await createInvoice(supplier.id, { invoiceDate: isoDay(-4) });

        const instant = invoice.invoiceDate.toDate().toISOString();
        const statement = await accountingService.getIncomeStatement({
            from: instant,
            to: instant,
        });

        expect(statement.taxes.ivaCreditable).toBe(0);
        expect(statement.reliability.invoicesWithoutTaxBreakdown).toBe(1);
        expect(statement.reliability.warnings.join(' ')).toContain('desglose de impuestos');
    });
});
