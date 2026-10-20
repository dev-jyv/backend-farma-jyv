import { Timestamp } from 'firebase-admin/firestore';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as accountingCore from '../src/services/accounting-core.service';
import * as invoicesService from '../src/services/invoices.service';
import { runIdempotentSupplierPayment } from '../src/services/supplier-payment-idempotency.service';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const crearFactura = async (total = 300) => {
    const supplier = await suppliersRepo.createSupplier({
        name: unique('Proveedor'),
        isActive: true,
    });
    const invoice = await invoicesRepo.createInvoice(
        invoicesRepo.generateInvoiceId(),
        {
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: Timestamp.now(),
            totalAmount: total,
            hasInvoice: false,
            paidTotal: 0,
        },
        'test-user',
    );
    return invoice;
};

const abono = (invoiceId: string, key: string | undefined, extra: Record<string, unknown> = {}) =>
    runIdempotentSupplierPayment({
        userId: 'uid-admin',
        invoiceId,
        key,
        run: () =>
            invoicesService.registerPayment(invoiceId, {
                amount: 100,
                paymentMethod: 'transfer',
                bankAccountId: 'banco-1',
                userId: 'uid-admin',
                roleSlug: 'admin',
                ...extra,
            }),
    });

/**
 * Dinero: un reintento tras una respuesta perdida no puede bajar el saldo dos
 * veces ni duplicar la salida contra la cuenta bancaria.
 */
describe('abonos a proveedor: idempotencia', () => {
    afterEach(() => jest.restoreAllMocks());

    it('reenviar con la misma llave registra un solo abono y el saldo baja una vez', async () => {
        const factura = await crearFactura();
        const key = unique('abono');

        const primero = await abono(factura.id, key);
        const reintento = await abono(factura.id, key);

        expect(reintento.payment.id).toBe(primero.payment.id);
        expect(reintento.invoice.balance).toBe(200);
        const abonos = await invoicesRepo.listPaymentsForInvoice(factura.id);
        expect(abonos).toHaveLength(1);
        expect(abonos[0].bankAccountId).toBe('banco-1');
        const actual = await invoicesRepo.getInvoiceById(factura.id);
        expect(actual?.paidTotal).toBe(100);
    });

    it('envíos concurrentes con la misma llave: un solo abono', async () => {
        const factura = await crearFactura();
        const key = unique('abono');

        const resultados = await Promise.allSettled(
            Array.from({ length: 5 }, () => abono(factura.id, key)),
        );

        const abonos = await invoicesRepo.listPaymentsForInvoice(factura.id);
        expect(abonos).toHaveLength(1);
        expect((await invoicesRepo.getInvoiceById(factura.id))?.paidTotal).toBe(100);
        expect(resultados.some((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('sin llave se comporta como hoy: dos abonos', async () => {
        const factura = await crearFactura();

        await abono(factura.id, undefined);
        await abono(factura.id, undefined);

        expect(await invoicesRepo.listPaymentsForInvoice(factura.id)).toHaveLength(2);
    });

    it('llaves distintas son abonos legítimos distintos', async () => {
        const factura = await crearFactura();

        await abono(factura.id, unique('a'));
        await abono(factura.id, unique('b'));

        expect(await invoicesRepo.listPaymentsForInvoice(factura.id)).toHaveLength(2);
    });

    it('un abono rechazado por exceder el saldo libera la llave', async () => {
        const factura = await crearFactura(50);
        const key = unique('abono');

        await expect(abono(factura.id, key)).rejects.toThrow();
        const ok = await abono(factura.id, key, { amount: 50 });

        expect(ok.invoice.balance).toBe(0);
        expect(await invoicesRepo.listPaymentsForInvoice(factura.id)).toHaveLength(1);
    });

    it('periodo cerrado: libera la llave y se aplica al reabrir con la misma llave', async () => {
        const factura = await crearFactura();
        const key = unique('abono');
        const spy = jest
            .spyOn(accountingCore, 'assertPeriodOpen')
            .mockRejectedValueOnce(new Error('Periodo cerrado'));

        await expect(abono(factura.id, key)).rejects.toThrow('Periodo cerrado');
        expect(await invoicesRepo.listPaymentsForInvoice(factura.id)).toHaveLength(0);

        const ok = await abono(factura.id, key);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(ok.invoice.balance).toBe(200);
    });

    it('la misma llave contra otra factura no devuelve el abono ajeno', async () => {
        const a = await crearFactura();
        const b = await crearFactura();
        const key = unique('abono');
        await abono(a.id, key);

        await expect(abono(b.id, key)).rejects.toThrow();
        expect(await invoicesRepo.listPaymentsForInvoice(b.id)).toHaveLength(0);
    });
});
