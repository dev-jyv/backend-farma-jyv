/**
 * SPEC 18: las fechas de calendario se guardan al mediodía UTC y todo lo que las
 * compara entiende también la representación anterior (medianoche UTC), que
 * convive hasta que corre el backfill.
 */

import { Timestamp } from 'firebase-admin/firestore';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as inventoryService from '../src/services/inventory.service';
import * as invoicesService from '../src/services/invoices.service';
import {
    backfillCollection,
    TARGETS,
} from '../src/scripts/backfill-calendar-dates';
import {
    calendarDayOf,
    calendarTimestampVariants,
    isLegacyMidnight,
    toCalendarTimestamp,
    toRangeEnd,
    toRangeStart,
} from '../src/utils/calendar-date';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const iso = (stamp: Timestamp) => stamp.toDate().toISOString();
const newSupplier = () =>
    suppliersRepo.createSupplier({ name: unique('Prov'), isActive: true });
const midnight = (day: string) => Timestamp.fromDate(new Date(`${day}T00:00:00.000Z`));

describe('utilidades de fecha de calendario', () => {
    it('una fecha de calendario se guarda al mediodía UTC', () => {
        expect(iso(toCalendarTimestamp('2026-10-31'))).toBe('2026-10-31T12:00:00.000Z');
    });

    it('un ISO con hora toma solo el día', () => {
        expect(iso(toCalendarTimestamp('2026-10-31T00:00:00.000Z'))).toBe(
            '2026-10-31T12:00:00.000Z',
        );
    });

    it('el día guardado es el mismo en las dos representaciones', () => {
        const [legacy, current] = calendarTimestampVariants('2026-10-31');
        expect(calendarDayOf(legacy)).toBe('2026-10-31');
        expect(calendarDayOf(current)).toBe('2026-10-31');
        expect(isLegacyMidnight(legacy)).toBe(true);
        expect(isLegacyMidnight(current)).toBe(false);
    });

    it('en México (UTC-6) el mediodía UTC sigue siendo el mismo día', () => {
        const local = new Date(toCalendarTimestamp('2026-10-31').toMillis() - 6 * 3600_000);
        expect(local.toISOString().slice(0, 10)).toBe('2026-10-31');
    });

    it('los filtros de rango abarcan el día completo', () => {
        expect(iso(toRangeStart('2026-10-31'))).toBe('2026-10-31T00:00:00.000Z');
        expect(iso(toRangeEnd('2026-10-31'))).toBe('2026-10-31T23:59:59.999Z');
        // Con hora real el instante se respeta tal cual.
        expect(iso(toRangeEnd('2026-10-31T10:30:00.000Z'))).toBe('2026-10-31T10:30:00.000Z');
    });
});

describe('facturas con fecha de calendario', () => {
    const makeInvoice = async (supplierId: string, invoiceDate: string, dueDate?: string) =>
        invoicesService.createInvoice({
            supplierId,
            invoiceNumber: unique('FAC'),
            invoiceDate,
            ...(dueDate ? { dueDate } : {}),
            totalAmount: 100,
            hasInvoice: false,
            userId: 'admin-user',
        });

    it('guarda la factura y el vencimiento al mediodía UTC', async () => {
        const supplier = await newSupplier();
        const created = await makeInvoice(supplier.id, '2031-10-31', '2031-11-15');

        const stored = (await db().collection('invoices').doc(created.id).get()).data()!;
        expect(iso(stored.invoiceDate)).toBe('2031-10-31T12:00:00.000Z');
        expect(iso(stored.dueDate)).toBe('2031-11-15T12:00:00.000Z');
    });

    it('un vencimiento el mismo día de la factura es válido', async () => {
        const supplier = await newSupplier();
        const created = await makeInvoice(supplier.id, '2031-10-31');

        const updated = await invoicesService.updateAccounting(created.id, {
            dueDate: '2031-10-31',
            userId: 'admin-user',
            roleSlug: 'admin',
        });
        expect(updated.dueDate).toBeTruthy();
    });

    it('un vencimiento anterior a la factura se rechaza, también a medianoche', async () => {
        const supplier = await newSupplier();
        const legacy = await db().collection('invoices').add({
            supplierId: supplier.id,
            invoiceNumber: unique('LEG'),
            invoiceDate: midnight('2031-10-31'),
            totalAmount: 100,
            paidTotal: 0,
            hasInvoice: false,
        });

        await expect(
            invoicesService.updateAccounting(legacy.id, {
                dueDate: '2031-10-30',
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(
            invoicesService.updateAccounting(legacy.id, {
                dueDate: '2031-10-31',
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).resolves.toBeTruthy();
    });

    it('el filtro "hasta" incluye las facturas de ese día en ambas formas', async () => {
        const supplier = await newSupplier();
        const noon = await makeInvoice(supplier.id, '2031-10-31');
        const legacy = await db().collection('invoices').add({
            supplierId: supplier.id,
            invoiceNumber: unique('LEG'),
            invoiceDate: midnight('2031-10-31'),
            totalAmount: 50,
            paidTotal: 0,
            hasInvoice: false,
        });

        const sameDay = await invoicesRepo.listInvoices({
            supplierId: supplier.id,
            from: '2031-10-31',
            to: '2031-10-31',
        });
        expect(sameDay.map((i) => i.id).sort()).toEqual([noon.id, legacy.id].sort());

        const before = await invoicesRepo.listInvoices({
            supplierId: supplier.id,
            to: '2031-10-30',
        });
        expect(before).toEqual([]);
    });
});

describe('lotes con caducidad de calendario', () => {
    const fixtures = async () => {
        const category = await categoriesRepo.createCategory({
            name: unique('Cat'),
            isActive: true,
        });
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
        const supplier = await newSupplier();
        const invoice = await invoicesService.createInvoice({
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: '2031-01-10',
            totalAmount: 100,
            hasInvoice: false,
            userId: 'admin-user',
        });
        return { product, invoice };
    };

    const entry = (invoiceId: string, productId: string, lotNumber: string, expiryDate: string) =>
        inventoryService.recordEntry({
            invoiceId,
            items: [{ productId, lotNumber, expiryDate, quantity: 5 }],
            userId: 'admin-user',
        });

    type BatchDoc = FirebaseFirestore.DocumentData & { id: string };
    const batchesOf = async (productId: string, lotNumber: string): Promise<BatchDoc[]> =>
        (await db().collection('batches').where('productId', '==', productId).get()).docs
            .filter((d) => d.get('lotNumber') === lotNumber)
            .map((d) => ({ id: d.id, ...d.data() }));

    it('una entrada nueva guarda la caducidad del lote y la partida a mediodía', async () => {
        const f = await fixtures();
        const lot = unique('LOTE');
        const created = await entry(f.invoice.id, f.product.id, lot, '2033-07-29');

        const [batch] = await batchesOf(f.product.id, lot);
        expect(iso(batch.expiryDate as Timestamp)).toBe('2033-07-29T12:00:00.000Z');
        expect(iso(created.items[0].expiryDate as Timestamp)).toBe('2033-07-29T12:00:00.000Z');
    });

    it('encuentra el lote guardado a medianoche (anterior) y a mediodía', async () => {
        const f = await fixtures();
        const lotOld = unique('OLD');
        const lotNew = unique('NEW');
        await db().collection('batches').add({
            productId: f.product.id, lotNumber: lotOld, expiryDate: midnight('2033-07-29'),
            quantity: 3, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
        });
        await db().collection('batches').add({
            productId: f.product.id,
            lotNumber: lotNew,
            expiryDate: toCalendarTimestamp('2033-07-29'),
            quantity: 3,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });

        expect(
            await batchesRepo.findBatchByProductLotAndExpiry(f.product.id, lotOld, '2033-07-29'),
        ).not.toBeNull();
        expect(
            await batchesRepo.findBatchByProductLotAndExpiry(f.product.id, lotNew, '2033-07-29'),
        ).not.toBeNull();
        expect(
            await batchesRepo.findBatchByProductLotAndExpiry(f.product.id, lotNew, '2033-07-30'),
        ).toBeNull();
    });

    it('un alta del mismo lote y caducidad no duplica el lote a medianoche', async () => {
        const f = await fixtures();
        const lot = unique('LOTE');
        await db().collection('batches').add({
            productId: f.product.id, lotNumber: lot, expiryDate: midnight('2033-07-29'),
            quantity: 3, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
        });

        await entry(f.invoice.id, f.product.id, lot, '2033-07-29');

        const batches = await batchesOf(f.product.id, lot);
        expect(batches).toHaveLength(1);
        expect(batches[0].quantity).toBe(8);
    });
});

describe('backfill:calendar-dates', () => {
    const byName = (name: string) => TARGETS.find((t) => t.collection === name)!;

    it('corrige solo lo que está exactamente a medianoche y es idempotente', async () => {
        const supplier = await newSupplier();
        const hora = Timestamp.fromDate(new Date('2031-10-31T10:30:00.000Z'));
        const invoice = await db().collection('invoices').add({
            supplierId: supplier.id, invoiceNumber: unique('F'), totalAmount: 1,
            invoiceDate: midnight('2031-10-31'), dueDate: hora, hasInvoice: false,
        });
        const batch = await db().collection('batches').add({
            productId: 'p', lotNumber: unique('L'), expiryDate: midnight('2033-07-29'), quantity: 1,
        });
        const noon = await db().collection('batches').add({
            productId: 'p', lotNumber: unique('L'), expiryDate: toCalendarTimestamp('2033-07-29'),
            quantity: 1,
        });
        const entryDoc = await db().collection('inventoryEntries').add({
            invoiceId: 'i',
            items: [
                { productId: 'p', expiryDate: midnight('2033-07-29'), quantity: 1 },
                { productId: 'q', expiryDate: toCalendarTimestamp('2033-08-01'), quantity: 2 },
            ],
        });

        const dry = await backfillCollection(byName('invoices'), true);
        expect(dry.documents).toBeGreaterThanOrEqual(1);
        expect(dry.written).toBe(0);
        expect(iso((await invoice.get()).get('invoiceDate'))).toBe('2031-10-31T00:00:00.000Z');

        for (const name of ['invoices', 'batches', 'inventoryEntries']) {
            await backfillCollection(byName(name), false);
        }

        const inv = (await invoice.get()).data()!;
        expect(iso(inv.invoiceDate)).toBe('2031-10-31T12:00:00.000Z');
        // Una hora real no es una fecha de calendario: no se toca.
        expect(iso(inv.dueDate)).toBe('2031-10-31T10:30:00.000Z');
        expect(iso((await batch.get()).get('expiryDate'))).toBe('2033-07-29T12:00:00.000Z');
        expect(iso((await noon.get()).get('expiryDate'))).toBe('2033-07-29T12:00:00.000Z');
        type Item = { expiryDate: Timestamp; productId: string };
        const items = (await entryDoc.get()).get('items') as Item[];
        expect(items.map((i) => iso(i.expiryDate))).toEqual([
            '2033-07-29T12:00:00.000Z',
            '2033-08-01T12:00:00.000Z',
        ]);
        expect(items.map((i) => i.productId)).toEqual(['p', 'q']);

        for (const name of ['invoices', 'batches', 'inventoryEntries']) {
            const again = await backfillCollection(byName(name), false);
            expect(again.documents).toBe(0);
            expect(again.written).toBe(0);
        }
    });
});
