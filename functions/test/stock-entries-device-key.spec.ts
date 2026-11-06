import { Timestamp } from 'firebase-admin/firestore';
import { createStockEntrySchema } from '../src/schemas';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const fixtures = async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Prod'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
    const supplier = await suppliersRepo.createSupplier({ name: unique('Prov'), isActive: true });
    const invoice = await invoicesRepo.createInvoice(
        invoicesRepo.generateInvoiceId(),
        {
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: Timestamp.now(),
            totalAmount: 100,
            hasInvoice: false,
        },
        'test-user',
    );
    const entrada = {
        invoiceId: invoice.id,
        lotNumber: unique('LOTE'),
        expiryDate: '2030-01-31',
        quantity: 5,
        productId: product.id,
        roleSlug: 'cashier',
        idempotencyKey: unique('entrada'),
    };
    return { product, invoice, entrada };
};

const stockOf = async (productId: string) =>
    (await productsRepo.getProductById(productId))!.totalStock;

const keyDoc = (id: string) => db().collection('stockEntryIdempotencyKeys').doc(id);

/**
 * SPEC 54 (B2): la llave de la entrada era `<usuario>:<llave>` y las entradas del
 * POS no tienen dueño. El cajero A sube una entrada, se pierde la respuesta, entra
 * el cajero B y la cola la reenvía: `B:<llave>` no existía y la entrada se
 * aplicaba dos veces.
 */
describe('createStockEntry: llave por caja (SPEC 54)', () => {
    it('la misma entrada reenviada por otro usuario desde la misma caja se aplica una vez',
        async () => {
            const { product, entrada } = await fixtures();
            const deviceId = unique('caja');

            const deA = await stockEntriesService.createStockEntry({
                ...entrada,
                deviceId,
                userId: 'uid-cajero-a',
            });
            const deB = await stockEntriesService.createStockEntry({
                ...entrada,
                deviceId,
                userId: 'uid-cajero-b',
                roleSlug: 'admin',
            });

            expect(deB.entry.id).toBe(deA.entry.id);
            expect(await stockOf(product.id)).toBe(5);
            const llave = await keyDoc(`${deviceId}:${entrada.idempotencyKey}`).get();
            expect(llave.data()).toMatchObject({
                deviceId,
                userId: 'uid-cajero-a',
                entryId: deA.entry.id,
            });
            expect((await keyDoc(`uid-cajero-b:${entrada.idempotencyKey}`).get()).exists)
                .toBe(false);
        });

    it('otro usuario desde la misma caja con la reserva en curso recibe ENTRY_IN_PROGRESS',
        async () => {
            const { product, entrada } = await fixtures();
            const deviceId = unique('caja');
            await keyDoc(`${deviceId}:${entrada.idempotencyKey}`).set({
                userId: 'uid-cajero-a',
                deviceId,
                createdAt: new Date(),
                reservedAt: new Date(),
            });

            await expect(stockEntriesService.createStockEntry({
                ...entrada,
                deviceId,
                userId: 'uid-cajero-b',
            })).rejects.toMatchObject({ syncCode: 'ENTRY_IN_PROGRESS' });
            expect(await stockOf(product.id)).toBe(0);
        });

    it('la misma llave en otra caja es otra entrada', async () => {
        const { product, entrada } = await fixtures();

        const a = await stockEntriesService.createStockEntry({
            ...entrada,
            deviceId: unique('caja-1'),
            userId: 'uid-cajero-a',
        });
        const b = await stockEntriesService.createStockEntry({
            ...entrada,
            deviceId: unique('caja-2'),
            userId: 'uid-cajero-a',
        });

        expect(b.entry.id).not.toBe(a.entry.id);
        expect(await stockOf(product.id)).toBe(10);
    });

    it('sin deviceId (caja anterior) la llave sigue siendo <usuario>:<llave>', async () => {
        const { product, entrada } = await fixtures();

        const primera = await stockEntriesService.createStockEntry({
            ...entrada,
            userId: 'uid-cajero-a',
        });
        const reintento = await stockEntriesService.createStockEntry({
            ...entrada,
            userId: 'uid-cajero-a',
        });

        expect(reintento.entry.id).toBe(primera.entry.id);
        expect(await stockOf(product.id)).toBe(5);
        expect((await keyDoc(`uid-cajero-a:${entrada.idempotencyKey}`).get()).data()?.entryId)
            .toBe(primera.entry.id);
    });

    it('la caja ya actualizada reconoce la entrada que aplicó con la llave vieja', async () => {
        const { product, entrada } = await fixtures();
        const vieja = await stockEntriesService.createStockEntry({
            ...entrada,
            userId: 'uid-cajero-a',
        });

        const nueva = await stockEntriesService.createStockEntry({
            ...entrada,
            deviceId: unique('caja'),
            userId: 'uid-cajero-a',
        });

        expect(nueva.entry.id).toBe(vieja.entry.id);
        expect(await stockOf(product.id)).toBe(5);
    });

    it('una reserva en curso con la llave vieja también frena el reintento con deviceId',
        async () => {
            const { product, entrada } = await fixtures();
            await keyDoc(`uid-cajero-a:${entrada.idempotencyKey}`).set({
                userId: 'uid-cajero-a',
                createdAt: new Date(),
            });

            await expect(stockEntriesService.createStockEntry({
                ...entrada,
                deviceId: unique('caja'),
                userId: 'uid-cajero-a',
            })).rejects.toMatchObject({ syncCode: 'ENTRY_IN_PROGRESS' });
            expect(await stockOf(product.id)).toBe(0);
        });
});

describe('createStockEntrySchema: deviceId', () => {
    const base = {
        invoiceId: 'f1',
        lotNumber: 'L1',
        expiryDate: '2030-01-31',
        quantity: 1,
        productId: 'p1',
    };

    it('es opcional y se acepta', () => {
        expect(createStockEntrySchema.safeParse(base).success).toBe(true);
        const parsed = createStockEntrySchema.safeParse({ ...base, deviceId: ' caja-1 ' });
        expect(parsed.success && parsed.data.deviceId).toBe('caja-1');
    });

    it('rechaza un deviceId que no puede ser parte del id del documento', () => {
        expect(createStockEntrySchema.safeParse({ ...base, deviceId: 'a/b' }).success)
            .toBe(false);
        expect(createStockEntrySchema.safeParse({ ...base, deviceId: '' }).success).toBe(false);
    });
});
