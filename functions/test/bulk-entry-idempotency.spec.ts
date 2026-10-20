/* eslint-disable max-len */
import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { bulkCreateEntriesIdempotent } from '../src/services/entry-idempotency.service';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const makeProduct = async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    return productsRepo.createProduct({
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
};

const setup = async () => {
    const supplier = await suppliersRepo.createSupplier({ name: unique('Prov'), isActive: true });
    const products = [await makeProduct(), await makeProduct(), await makeProduct()];
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
    const group = (productId: string, lot: string, quantity = 5) => ({
        supplierId: supplier.id,
        items: [{ productId, lotNumber: lot, expiryDate: '2027-06-01', quantity }],
    });
    return { supplier, products, invoice, group };
};

const stockOf = async (id: string) => (await productsRepo.getProductById(id))!.totalStock;
const keyDocs = async (userId: string) =>
    (await db().collection('stockEntryIdempotencyKeys').where('userId', '==', userId).get()).size;

describe('bulkCreateEntriesIdempotent', () => {
    it('reenviar la misma carga no suma el stock otra vez y devuelve los mismos grupos', async () => {
        const s = await setup();
        const key = unique('bulk-key');
        const user = unique('u');
        const entries = s.products.map((p, i) => s.group(p.id, `L${i}`));

        const first = await bulkCreateEntriesIdempotent({ userId: user, key, entries });
        const retry = await bulkCreateEntriesIdempotent({ userId: user, key, entries });

        expect(first.errors).toEqual([]);
        expect(retry.errors).toEqual([]);
        expect(retry.created.map((e) => e.id)).toEqual(first.created.map((e) => e.id));
        for (const p of s.products) {
            expect(await stockOf(p.id)).toBe(5);
        }
    });

    it('con un grupo inválido: reenviar corregido no duplica los válidos y aplica el corregido', async () => {
        const s = await setup();
        const key = unique('bulk-key');
        const user = unique('u');
        const bad = { supplierId: s.supplier.id, items: [{ productId: 'no-existe', lotNumber: 'X', expiryDate: '2027-06-01', quantity: 3 }] };
        const good0 = s.group(s.products[0].id, 'A');
        const good2 = s.group(s.products[2].id, 'C');

        const first = await bulkCreateEntriesIdempotent({ userId: user, key, entries: [good0, bad, good2] });
        expect(first.created).toHaveLength(2);
        expect(first.errors.map((e) => e.index)).toEqual([1]);

        const fixed = s.group(s.products[1].id, 'B');
        const second = await bulkCreateEntriesIdempotent({ userId: user, key, entries: [good0, fixed, good2] });
        expect(second.errors).toEqual([]);
        expect(second.created).toHaveLength(3);
        for (const p of s.products) {
            expect(await stockOf(p.id)).toBe(5);
        }
    });

    it('reordenar grupos e ítems no duplica', async () => {
        const s = await setup();
        const key = unique('bulk-key');
        const user = unique('u');
        const multi = {
            supplierId: s.supplier.id,
            items: [
                { productId: s.products[0].id, lotNumber: 'A', expiryDate: '2027-06-01', quantity: 2 },
                { productId: s.products[1].id, lotNumber: 'B', expiryDate: '2027-06-01', quantity: 4 },
            ],
        };
        const other = s.group(s.products[2].id, 'C');
        await bulkCreateEntriesIdempotent({ userId: user, key, entries: [multi, other] });
        const reordered = { ...multi, items: [...multi.items].reverse() };
        const retry = await bulkCreateEntriesIdempotent({ userId: user, key, entries: [other, reordered] });
        expect(retry.errors).toEqual([]);
        expect(await stockOf(s.products[0].id)).toBe(2);
        expect(await stockOf(s.products[1].id)).toBe(4);
        expect(await stockOf(s.products[2].id)).toBe(5);
    });

    it('sin llave no crea documentos de llave', async () => {
        const s = await setup();
        const user = unique('u');
        const result = await bulkCreateEntriesIdempotent({
            userId: user,
            entries: [s.group(s.products[0].id, 'A')],
        });
        expect(result.created).toHaveLength(1);
        expect(await keyDocs(user)).toBe(0);
    });

    it('dos envíos simultáneos aplican cada grupo una vez', async () => {
        const s = await setup();
        const key = unique('bulk-key');
        const user = unique('u');
        const entries = s.products.map((p, i) => s.group(p.id, `L${i}`));
        await Promise.all([
            bulkCreateEntriesIdempotent({ userId: user, key, entries }),
            bulkCreateEntriesIdempotent({ userId: user, key, entries }),
        ]);
        for (const p of s.products) {
            expect(await stockOf(p.id)).toBe(5);
        }
    });

    it('grupos por factura usan su alcance y no se duplican', async () => {
        const s = await setup();
        const key = unique('bulk-key');
        const user = unique('u');
        const entries = [{
            invoiceId: s.invoice.id,
            items: [{ productId: s.products[0].id, lotNumber: 'F1', expiryDate: '2027-06-01', quantity: 7 }],
        }];
        await bulkCreateEntriesIdempotent({ userId: user, key, entries });
        await bulkCreateEntriesIdempotent({ userId: user, key, entries });
        expect(await stockOf(s.products[0].id)).toBe(7);
    });

    it('otro usuario con la misma llave no se confunde', async () => {
        const s = await setup();
        const key = unique('bulk-key');
        const entries = [s.group(s.products[0].id, 'A')];
        await bulkCreateEntriesIdempotent({ userId: unique('u'), key, entries });
        await bulkCreateEntriesIdempotent({ userId: unique('u'), key, entries });
        expect(await stockOf(s.products[0].id)).toBe(10);
    });
});
