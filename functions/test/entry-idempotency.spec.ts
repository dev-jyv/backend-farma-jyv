import { Timestamp } from 'firebase-admin/firestore';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { runIdempotentEntry } from '../src/services/entry-idempotency.service';
import * as inventoryService from '../src/services/inventory.service';
import { AppError } from '../src/utils/errors';

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
    return { product, invoice };
};

const enter = (
    f: { product: { id: string }; invoice: { id: string } },
    userId: string,
    key: string | undefined,
    quantity = 10,
    scope: 'invoice-entry' | 'direct-entry' = 'invoice-entry',
) =>
    runIdempotentEntry({
        userId,
        scope,
        key,
        releaseOnFailure: true,
        run: () =>
            inventoryService.recordEntry({
                invoiceId: f.invoice.id,
                items: [{
                    productId: f.product.id,
                    lotNumber: unique('LOTE'),
                    expiryDate: '2027-06-01',
                    quantity,
                }],
                userId,
            }),
    });

const stockOf = async (productId: string) =>
    (await productsRepo.getProductById(productId))!.totalStock;

describe('runIdempotentEntry', () => {
    it('el reintento con la misma llave devuelve la entrada y no suma stock', async () => {
        const f = await fixtures();
        const key = unique('key-entry');

        const first = await enter(f, 'u1', key);
        const retry = await enter(f, 'u1', key);

        expect(retry.id).toBe(first.id);
        expect(await stockOf(f.product.id)).toBe(10);
        expect((await batchesRepo.listBatchesWithStock()).filter(
            (batch) => batch.productId === f.product.id,
        )).toHaveLength(1);
    });

    it('sin llave cada llamada es una entrada nueva (clientes anteriores)', async () => {
        const f = await fixtures();
        await enter(f, 'u1', undefined);
        await enter(f, 'u1', undefined);
        expect(await stockOf(f.product.id)).toBe(20);
    });

    it('la misma llave en otro usuario o en otro endpoint no se confunde', async () => {
        const f = await fixtures();
        const key = unique('key-shared');

        const a = await enter(f, 'u1', key);
        const b = await enter(f, 'u2', key);
        const c = await enter(f, 'u1', key, 10, 'direct-entry');

        expect(new Set([a.id, b.id, c.id]).size).toBe(3);
        expect(await stockOf(f.product.id)).toBe(30);
    });

    it('dos envíos simultáneos con la misma llave aplican la entrada una vez', async () => {
        const f = await fixtures();
        const key = unique('key-race');

        const results = await Promise.allSettled([enter(f, 'u1', key), enter(f, 'u1', key)]);

        expect(await stockOf(f.product.id)).toBe(10);
        const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        // El perdedor recibe la entrada ya guardada o un 409 si aún estaba en curso.
        rejected.forEach((r) => expect(r.reason).toBeInstanceOf(AppError));
    });

    it('un fallo de validación libera la llave: el intento corregido sí se aplica', async () => {
        const f = await fixtures();
        const key = unique('key-fail');

        await expect(enter(f, 'u1', key, -5)).rejects.toBeInstanceOf(AppError);
        expect(await stockOf(f.product.id)).toBe(0);

        const fixed = await enter(f, 'u1', key, 4);
        expect(fixed.id).toBeTruthy();
        expect(await stockOf(f.product.id)).toBe(4);
    });

    it('una llave reservada sin entrada (proceso caído) pide revisión', async () => {
        const f = await fixtures();
        const key = unique('key-stuck');
        await expect(
            runIdempotentEntry({
                userId: 'u1',
                scope: 'invoice-entry',
                key,
                releaseOnFailure: false,
                run: () => Promise.reject(new Error('cae a medias')),
            }),
        ).rejects.toThrow('cae a medias');

        await expect(enter(f, 'u1', key)).rejects.toMatchObject({ statusCode: 409 });
        expect(await stockOf(f.product.id)).toBe(0);
    });
});
