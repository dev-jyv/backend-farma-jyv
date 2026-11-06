import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import {
    createStockEntrySchema,
    createSupplierPaymentSchema,
    inventoryEntrySchema,
} from '../src/schemas';
import * as inventoryService from '../src/services/inventory.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { extractInvoiceData } from '../src/services/invoice-rag.service';
import { Batch } from '../src/types';
import { UploadedFile } from '../src/types/uploads';
import {
    deterministicBatchId,
    normalizeLotKey,
    weightedBatchCost,
} from '../src/utils/batch-lot';
import { toCalendarTimestamp } from '../src/utils/calendar-date';
import { db } from '../src/utils/firestore';

/**
 * SPEC 59: un lote por producto + lote normalizado + caducidad, decidido dentro de
 * la transacción; costo ponderado; caducidad validada en el día de México.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const fixtures = async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Prod'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 20,
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
            totalAmount: 1000,
            hasInvoice: false,
        },
        'test-user',
    );
    return { product, supplier, invoice };
};

const batchesOf = async (productId: string): Promise<Batch[]> =>
    (await db().collection('batches').where('productId', '==', productId).get())
        .docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Batch);

const stockOf = async (productId: string) =>
    (await productsRepo.getProductById(productId))!.totalStock;

const entry = (
    invoiceId: string,
    productId: string,
    item: { lotNumber: string; quantity: number; costPrice?: number; expiryDate?: string },
) => inventoryService.recordEntry({
    invoiceId,
    userId: 'uid-almacen',
    items: [{ productId, expiryDate: '2030-01-31', ...item }],
});

describe('lote normalizado e id determinista', () => {
    it('"abc 12" y "ABC12" son el mismo lote', () => {
        expect(normalizeLotKey('abc 12')).toBe('ABC12');
        expect(normalizeLotKey(' a b\tc12 ')).toBe('ABC12');
        expect(deterministicBatchId('p1', 'ABC12', '2030-01-31'))
            .toBe(deterministicBatchId('p1', normalizeLotKey('abc 12'), '2030-01-31'));
        expect(deterministicBatchId('p1', 'ABC12', '2030-01-31'))
            .not.toBe(deterministicBatchId('p1', 'ABC12', '2030-02-28'));
    });

    it('dos entradas con el lote escrito distinto suman al mismo lote', async () => {
        const { product, invoice } = await fixtures();
        await entry(invoice.id, product.id, { lotNumber: 'abc 12', quantity: 4 });
        await entry(invoice.id, product.id, { lotNumber: 'ABC12', quantity: 6 });

        const batches = await batchesOf(product.id);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toMatchObject({ quantity: 10, lotKey: 'ABC12', lotNumber: 'abc 12' });
        expect(batches[0].id).toBe(deterministicBatchId(product.id, 'ABC12', '2030-01-31'));
        expect(await stockOf(product.id)).toBe(10);
    });

    it('dos entradas concurrentes del mismo lote nuevo crean un solo lote con la suma',
        async () => {
            const { product, invoice } = await fixtures();
            await Promise.all([
                entry(invoice.id, product.id, { lotNumber: 'L-CONC', quantity: 3 }),
                entry(invoice.id, product.id, { lotNumber: 'l-conc', quantity: 5 }),
            ]);

            const batches = await batchesOf(product.id);
            expect(batches).toHaveLength(1);
            expect(batches[0].quantity).toBe(8);
            expect(await stockOf(product.id)).toBe(8);
            const movements = await db().collection('stockMovements')
                .where('productId', '==', product.id).get();
            expect(movements.docs.map((doc) => doc.data().batchId))
                .toEqual([batches[0].id, batches[0].id]);
        });

    it('encuentra un lote anterior (id aleatorio, sin lotKey) y le pone su llave', async () => {
        const { product, invoice } = await fixtures();
        const legacy = await db().collection('batches').add({
            productId: product.id,
            lotNumber: 'LEG7',
            // Caducidad guardada a medianoche UTC, como antes de SPEC 18.
            expiryDate: Timestamp.fromDate(new Date('2030-01-31T00:00:00Z')),
            quantity: 2,
            costPrice: 10,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });

        await entry(invoice.id, product.id, { lotNumber: 'leg7', quantity: 2, costPrice: 12 });

        const batches = await batchesOf(product.id);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toMatchObject({
            id: legacy.id,
            quantity: 4,
            lotKey: 'LEG7',
            costPrice: 11,
        });
    });
});

describe('costo ponderado', () => {
    it('10 a $10 más 10 a $12 da $11', () => {
        expect(weightedBatchCost(10, 10, 10, 12)).toBe(11);
    });

    it('si uno no tiene costo se queda el que exista; redondea a 4 decimales', () => {
        expect(weightedBatchCost(10, undefined, 5, 12)).toBe(12);
        expect(weightedBatchCost(10, 9.5, 5, undefined)).toBe(9.5);
        expect(weightedBatchCost(10, null, 5, null)).toBeUndefined();
        expect(weightedBatchCost(1, 10, 2, 11)).toBe(10.6667);
        // Un lote agotado no pondera.
        expect(weightedBatchCost(0, 50, 4, 12)).toBe(12);
    });

    it('al sumar a un lote existente guarda el promedio, no el último costo', async () => {
        const { product, invoice } = await fixtures();
        await entry(invoice.id, product.id, { lotNumber: 'COST-1', quantity: 10, costPrice: 10 });
        await entry(invoice.id, product.id, { lotNumber: 'COST-1', quantity: 10, costPrice: 12 });

        const [batch] = await batchesOf(product.id);
        expect(batch).toMatchObject({ quantity: 20, costPrice: 11 });
    });
});

describe('mismo lote con otra caducidad', () => {
    it('la entrada se acepta y devuelve LOT_EXPIRY_MISMATCH', async () => {
        const { product, invoice } = await fixtures();
        const primera = await entry(invoice.id, product.id, {
            lotNumber: 'MM-1',
            quantity: 5,
        });
        expect(primera.warnings).toBeUndefined();

        const segunda = await entry(invoice.id, product.id, {
            lotNumber: 'mm-1 ',
            quantity: 5,
            expiryDate: '2030-06-30',
        });
        expect(segunda.warnings).toEqual(['LOT_EXPIRY_MISMATCH']);
        expect(await batchesOf(product.id)).toHaveLength(2);
        expect(await stockOf(product.id)).toBe(10);
    });

    it('createStockEntry la devuelve en warnings y en details.warnings', async () => {
        const { product, invoice } = await fixtures();
        const base = {
            invoiceId: invoice.id,
            productId: product.id,
            quantity: 3,
            userId: 'uid-cajero',
            roleSlug: 'cashier',
        };
        const ok = await stockEntriesService.createStockEntry({
            ...base,
            lotNumber: 'X-9',
            expiryDate: '2030-01-31',
            idempotencyKey: unique('k'),
        });
        expect(ok.warnings).toBeUndefined();
        expect(ok.details).toBeUndefined();

        const result = await stockEntriesService.createStockEntry({
            ...base,
            lotNumber: 'X-9',
            expiryDate: '2030-03-31',
            idempotencyKey: unique('k'),
        });
        expect(result.warnings).toEqual(['LOT_EXPIRY_MISMATCH']);
        expect(result.details).toEqual({ warnings: ['LOT_EXPIRY_MISMATCH'] });
        expect('warnings' in result.entry).toBe(false);
        expect(result.stock).toBe(6);
    });
});

describe('caducidad en el día de la farmacia', () => {
    // 20 oct 2026, 19:00 en México: el día UTC ya es el 21.
    const MX_EVENING = new Date('2026-10-21T01:00:00Z');
    const base = { invoiceId: 'inv-1', lotNumber: 'L1', quantity: 1, productId: 'p1' };

    beforeEach(() => {
        jest.useFakeTimers({ now: MX_EVENING, doNotFake: ['nextTick', 'setImmediate'] });
    });
    afterEach(() => jest.useRealTimers());

    it('una caducidad igual a hoy, a las 19:00 hora de México, se acepta', () => {
        expect(createStockEntrySchema.safeParse({ ...base, expiryDate: '2026-10-20' }).success)
            .toBe(true);
        expect(inventoryEntrySchema.safeParse({
            invoiceId: 'inv-1',
            items: [{ productId: 'p1', lotNumber: 'L1', quantity: 1, expiryDate: '2026-10-20' }],
        }).success).toBe(true);
    });

    it('ayer sigue rechazado', () => {
        const result = createStockEntrySchema.safeParse({ ...base, expiryDate: '2026-10-19' });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues))
            .toContain('La fecha de caducidad no puede estar en el pasado');
    });

    it('se compara contra el día de la captura: capturada el 5 con caducidad del 6, ' +
        'sincronizada el 7, se acepta', () => {
        jest.setSystemTime(new Date('2026-11-07T18:00:00Z'));
        const capturada = {
            ...base,
            expiryDate: '2026-11-06',
            // 5 nov, 20:00 en México (ya 6 nov en UTC).
            capturedAt: '2026-11-06T02:00:00Z',
        };
        expect(createStockEntrySchema.safeParse(capturada).success).toBe(true);
        expect(createStockEntrySchema.safeParse({ ...capturada, capturedAt: undefined }).success)
            .toBe(false);
        expect(createStockEntrySchema.safeParse({ ...capturada, capturedAt: 'ayer' }).success)
            .toBe(false);
    });

    it('la fecha de pago de hoy a las 19:00 de México no es "futuro"', () => {
        const pago = { amount: 10, paymentMethod: 'cash' as const };
        expect(createSupplierPaymentSchema.safeParse({ ...pago, paidAt: '2026-10-20' }).success)
            .toBe(true);
        expect(createSupplierPaymentSchema.safeParse({ ...pago, paidAt: '2026-10-21' }).success)
            .toBe(false);
    });
});

describe('prompt de la IA de facturas', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        delete process.env.OPENROUTER_API_KEY;
    });

    it('dice que las fechas vienen en DD/MM/AAAA, que MM/AAAA es fin de mes y pide el UUID',
        async () => {
            process.env.OPENROUTER_API_KEY = 'sk-or-test';
            let system = '';
            global.fetch = (async (_url: string, init: RequestInit) => {
                const body = JSON.parse(String(init.body));
                system = body.messages[0].content;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ choices: [{ message: { content: '{}' } }] }),
                } as Response;
            }) as unknown as typeof fetch;
            const file: UploadedFile = {
                fieldname: 'file',
                originalname: 'f.png',
                encoding: '7bit',
                mimetype: 'image/png',
                size: 1,
                buffer: Buffer.from('x'),
            };

            await extractInvoiceData(file).catch(() => undefined);

            expect(system).toContain('DD/MM/AAAA');
            expect(system).toMatch(/MM\/AAAA.*último día de ese mes/);
            expect(system).toContain('cfdiUuid');
        });
});

describe('id determinista en el documento', () => {
    it('un lote nuevo se guarda con id derivado y caducidad al mediodía', async () => {
        const { product, invoice } = await fixtures();
        await entry(invoice.id, product.id, { lotNumber: 'n-1', quantity: 1 });
        const id = deterministicBatchId(product.id, 'N-1', '2030-01-31');
        const doc = await db().collection('batches').doc(id).get();
        expect(doc.exists).toBe(true);
        expect((doc.data()!.expiryDate as Timestamp).toMillis())
            .toBe(toCalendarTimestamp('2030-01-31').toMillis());
    });
});
