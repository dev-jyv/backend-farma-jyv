import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as controlledService from '../src/services/controlled.service';
import * as inventoryService from '../src/services/inventory.service';
import * as salesService from '../src/services/sales.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { libroControlados } from '../src/services/report-export/definitions/compliance';
import { ControlledGroup, ControlledLedgerEntry } from '../src/types';
import { db } from '../src/utils/firestore';

/**
 * SPEC 61: entradas, cancelaciones de entrada y salidas por merma o caducidad de
 * medicamentos controlados en el libro de control, dentro de la transacción que
 * mueve el inventario.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const EXPIRY = '2031-05-31';

const fixtures = async (controlledGroup?: ControlledGroup) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Clonazepam'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'caja',
        salePrice: 120,
        minStock: 0,
        totalStock: 0,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        ...(controlledGroup ? { controlledGroup } : {}),
        isActive: true,
        suppliers: [],
    });
    const supplier = await suppliersRepo.createSupplier({ name: unique('Nadro'), isActive: true });
    const invoice = await invoicesRepo.createInvoice(
        invoicesRepo.generateInvoiceId(),
        {
            supplierId: supplier.id,
            invoiceNumber: unique('F'),
            invoiceDate: Timestamp.now(),
            totalAmount: 1000,
            hasInvoice: true,
        },
        'test-user',
    );
    return { category, product, supplier, invoice };
};

const ledgerOf = async (productId: string): Promise<ControlledLedgerEntry[]> =>
    (await controlledService.listControlledLedger({ productId, limit: 1000 })).items;

const entradaPorFactura = (invoiceId: string, productId: string, quantity = 30) =>
    inventoryService.recordEntry({
        invoiceId,
        items: [{ productId, lotNumber: 'L-77', expiryDate: EXPIRY, quantity, costPrice: 50 }],
        userId: 'uid-almacen',
    });

describe('entradas de controlados en el libro (SPEC 61)', () => {
    it('la entrada de un grupo II escribe un renglón `entry` con lote, proveedor y factura',
        async () => {
            const { product, supplier, invoice } = await fixtures('II');
            const entry = await entradaPorFactura(invoice.id, product.id);

            const rows = await ledgerOf(product.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                type: 'entry',
                saleId: '',
                saleFolio: '',
                productId: product.id,
                productName: product.name,
                controlledGroup: 'II',
                quantity: 30,
                lotNumbers: ['L-77'],
                batchId: entry.items[0].batchId,
                expiryDate: EXPIRY,
                supplierId: supplier.id,
                supplierName: supplier.name,
                invoiceId: invoice.id,
                invoiceFolio: invoice.invoiceNumber,
                entryId: entry.id,
                userId: 'uid-almacen',
                prescription: null,
                prescriptionRetained: false,
            });
            // Mismo instante que la entrada: se escribió en su transacción.
            expect(rows[0].createdAt.toMillis()).toBe(entry.createdAt.toMillis());
        });

    it('si el asiento falla, la entrada no se aplica (misma transacción)', async () => {
        const { product, invoice } = await fixtures('I');
        const spy = jest.spyOn(controlledService, 'writeStockLedgerEntryInTransaction')
            .mockImplementation(() => {
                throw new Error('falla del libro');
            });
        try {
            await expect(entradaPorFactura(invoice.id, product.id)).rejects.toThrow('falla');
        } finally {
            spy.mockRestore();
        }

        expect((await productsRepo.getProductById(product.id))!.totalStock).toBe(0);
        const batches = await db().collection('batches')
            .where('productId', '==', product.id).get();
        expect(batches.empty).toBe(true);
        const entries = await db().collection('inventoryEntries')
            .where('invoiceId', '==', invoice.id).get();
        expect(entries.empty).toBe(true);
    });

    it('grupos V y VI y productos sin grupo no se asientan', async () => {
        for (const group of ['V', 'VI', undefined] as const) {
            const { product, invoice } = await fixtures(group);
            await entradaPorFactura(invoice.id, product.id);
            expect(await ledgerOf(product.id)).toEqual([]);
        }
    });

    it('el grupo IV, que lleva libro según constants/controlled.ts, sí se asienta', async () => {
        const { product, invoice } = await fixtures('IV');
        await entradaPorFactura(invoice.id, product.id);
        expect((await ledgerOf(product.id)).map((row) => row.type)).toEqual(['entry']);
    });

    it('entrada directa con un producto en línea controlado: se asienta sin factura',
        async () => {
            const { category, supplier } = await fixtures();
            const sku = unique('SKU-LINEA');
            await inventoryService.recordDirectEntry({
                supplierId: supplier.id,
                userId: 'uid-almacen',
                items: [{
                    product: {
                        name: unique('Tramadol'),
                        sku,
                        categoryId: category.id,
                        unit: 'caja',
                        salePrice: 90,
                        minStock: 0,
                        hasIva: false,
                        hasIvaZero: true,
                        hasIeps: false,
                        controlledGroup: 'III',
                    },
                    lotNumber: 'T9',
                    expiryDate: EXPIRY,
                    quantity: 20,
                }],
            });

            const created = await productsRepo.findProductBySku(sku);
            const rows = await ledgerOf(created!.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                type: 'entry',
                controlledGroup: 'III',
                quantity: 20,
                lotNumbers: ['T9'],
                supplierName: supplier.name,
                invoiceId: null,
                invoiceFolio: null,
            });
        });

    it('la entrada desde la caja también se asienta', async () => {
        const { product, invoice } = await fixtures('II');
        await stockEntriesService.createStockEntry({
            invoiceId: invoice.id,
            productId: product.id,
            lotNumber: 'C-1',
            expiryDate: EXPIRY,
            quantity: 4,
            userId: 'uid-cajero',
            roleSlug: 'cashier',
            idempotencyKey: unique('k'),
        });
        const rows = await ledgerOf(product.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type: 'entry', quantity: 4, userId: 'uid-cajero' });
    });

    it('un producto que pasa de libre a controlado no se reescribe hacia atrás', async () => {
        const { product, invoice } = await fixtures();
        await entradaPorFactura(invoice.id, product.id);
        await productsRepo.updateProduct(product.id, { controlledGroup: 'II' });
        expect(await ledgerOf(product.id)).toEqual([]);
    });
});

describe('salidas por merma y caducidad (SPEC 61)', () => {
    it('una merma de un controlado escribe `exit_waste` negativo', async () => {
        const { product, invoice } = await fixtures('II');
        const entry = await entradaPorFactura(invoice.id, product.id, 10);
        const batchId = entry.items[0].batchId;

        const { movement } = await inventoryService.recordExit({
            productId: product.id,
            batchId,
            quantity: 3,
            reason: 'waste',
            notes: 'Caja rota',
            userId: 'uid-almacen',
        });

        const rows = await ledgerOf(product.id);
        const merma = rows.find((row) => row.type === 'exit_waste');
        expect(merma).toMatchObject({
            quantity: -3,
            batchId,
            lotNumbers: ['L-77'],
            expiryDate: EXPIRY,
            controlledGroup: 'II',
            supplierId: null,
            invoiceId: null,
            userId: 'uid-almacen',
        });
        expect(merma!.createdAt.toMillis()).toBe(movement.createdAt.toMillis());
    });

    it('una salida por caducidad escribe `exit_expiry` negativo; un libre no escribe nada',
        async () => {
            const controlado = await fixtures('I');
            const entry = await entradaPorFactura(controlado.invoice.id, controlado.product.id, 5);
            await inventoryService.recordExit({
                productId: controlado.product.id,
                batchId: entry.items[0].batchId,
                quantity: 5,
                reason: 'expiry',
                userId: 'u1',
            });
            const rows = await ledgerOf(controlado.product.id);
            expect(rows.map((row) => [row.type, row.quantity]))
                .toEqual([['entry', 5], ['exit_expiry', -5]]);

            const libre = await fixtures('VI');
            const libreEntry = await entradaPorFactura(libre.invoice.id, libre.product.id, 5);
            await inventoryService.recordExit({
                productId: libre.product.id,
                batchId: libreEntry.items[0].batchId,
                quantity: 1,
                reason: 'waste',
                userId: 'u1',
            });
            expect(await ledgerOf(libre.product.id)).toEqual([]);
        });
});

describe('cancelación de una entrada de controlado (SPEC 58 + 61)', () => {
    it('escribe el contra-asiento `entry_cancel` en la misma transacción', async () => {
        const { product, supplier, invoice } = await fixtures('II');
        const entry = await entradaPorFactura(invoice.id, product.id, 12);

        const cancelled = await inventoryService.cancelEntry({
            entryId: entry.id,
            reason: 'Factura capturada dos veces',
            userId: 'uid-gerente',
            roleSlug: 'manager',
        });

        const rows = await ledgerOf(product.id);
        expect(rows.map((row) => row.type)).toEqual(['entry', 'entry_cancel']);
        expect(rows[1]).toMatchObject({
            quantity: -12,
            lotNumbers: ['L-77'],
            batchId: entry.items[0].batchId,
            expiryDate: EXPIRY,
            supplierId: supplier.id,
            supplierName: supplier.name,
            invoiceFolio: invoice.invoiceNumber,
            entryId: entry.id,
            userId: 'uid-gerente',
        });
        expect(rows[1].createdAt.toMillis()).toBe(cancelled.cancelledAt!.toMillis());
        expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(0);
    });

    it('una cancelación rechazada no deja contra-asiento', async () => {
        const { product, invoice } = await fixtures('II');
        const entry = await entradaPorFactura(invoice.id, product.id, 12);
        await inventoryService.recordExit({
            productId: product.id,
            batchId: entry.items[0].batchId,
            quantity: 1,
            reason: 'waste',
            userId: 'u1',
        });

        await expect(inventoryService.cancelEntry({
            entryId: entry.id,
            reason: 'Ya no está completa',
            userId: 'uid-gerente',
            roleSlug: 'manager',
        })).rejects.toMatchObject({ statusCode: 400 });
        expect((await ledgerOf(product.id)).map((row) => row.type))
            .toEqual(['entry', 'exit_waste']);
    });

    it('contra-asienta lo que se asentó: ni más si el producto se volvió controlado, ni menos',
        async () => {
            // Libre al recibir, controlado al cancelar: no hay renglón que cancelar.
            const libre = await fixtures();
            const libreEntry = await entradaPorFactura(libre.invoice.id, libre.product.id);
            await productsRepo.updateProduct(libre.product.id, { controlledGroup: 'II' });
            await inventoryService.cancelEntry({
                entryId: libreEntry.id,
                reason: 'Captura equivocada',
                userId: 'u1',
                roleSlug: 'admin',
            });
            expect(await ledgerOf(libre.product.id)).toEqual([]);

            // Controlado al recibir, libre al cancelar: el contra-asiento sí va.
            const controlado = await fixtures('I');
            const entry = await entradaPorFactura(controlado.invoice.id, controlado.product.id);
            await productsRepo.updateProduct(controlado.product.id, { controlledGroup: 'VI' });
            await inventoryService.cancelEntry({
                entryId: entry.id,
                reason: 'Captura equivocada',
                userId: 'u1',
                roleSlug: 'admin',
            });
            expect((await ledgerOf(controlado.product.id)).map((row) => row.quantity))
                .toEqual([30, -30]);
        });
});

describe('listado y exportación del libro con los tipos nuevos (SPEC 61)', () => {
    const LEGACY_HEADERS = [
        'Fecha', 'Movimiento', 'Folio venta', 'Folio devolución', 'Grupo', 'Producto',
        'Cantidad', 'Lotes', 'Médico', 'Cédula', 'Folio receta', 'Receta retenida',
        'Cliente', 'Usuario',
    ];

    const ventaControlada = async (productId: string) => {
        const session = await cashSessionsRepo.createCashSession({
            openedBy: 'test-cashier',
            openingAmount: 0,
            expectedCashAmount: null,
            countedCashAmount: null,
            cashDifference: null,
            closedBy: null,
            closedAt: null,
        });
        return salesService.createSale({
            items: [{ productId, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 500,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            prescription: { doctorName: 'Dra. Ana', doctorLicense: '1234567', folio: 'R-1' },
            prescriptionRetained: true,
        });
    };

    it('el CSV del periodo incluye las entradas y conserva el orden de las columnas',
        async () => {
            const { product, supplier, invoice } = await fixtures('II');
            await entradaPorFactura(invoice.id, product.id, 30);
            const sale = await ventaControlada(product.id);

            const { csv, rows } = await controlledService.exportControlledLedger({
                productId: product.id,
                roleSlug: 'admin',
            });
            expect(rows).toBe(2);
            const lines = csv.replace(/^\ufeff/, '').trim().split('\r\n');
            expect(lines[0]).toBe([...LEGACY_HEADERS, 'Proveedor', 'Factura'].join(','));

            const entrada = lines.find((line) => line.includes(',Entrada,'))!;
            const cells = entrada.split(',');
            expect(cells).toHaveLength(16);
            expect(cells[1]).toBe('Entrada');
            expect(cells[6]).toBe('30');
            expect(cells[7]).toBe('L-77');
            expect(cells[14]).toBe(supplier.name);
            expect(cells[15]).toBe(invoice.invoiceNumber);

            // La venta conserva sus columnas y deja vacías proveedor y factura.
            const venta = lines.find((line) => line.includes(sale.folio))!.split(',');
            expect(venta[1]).toBe('Venta');
            expect(venta[9]).toBe('1234567');
            expect(venta.slice(14)).toEqual(['', '']);
        });

    it('el listado paginado incluye los tipos nuevos con sus campos', async () => {
        const { product, invoice } = await fixtures('III');
        const entry = await entradaPorFactura(invoice.id, product.id, 8);
        await inventoryService.recordExit({
            productId: product.id,
            batchId: entry.items[0].batchId,
            quantity: 2,
            reason: 'expiry',
            userId: 'u1',
        });

        const { items } = await controlledService.listControlledLedger({ group: 'III' });
        const mine = items.filter((row) => row.productId === product.id);
        expect(mine.map((row) => [row.type, row.quantity])).toEqual([
            ['entry', 8],
            ['exit_expiry', -2],
        ]);
        expect(mine[0]).toMatchObject({ invoiceFolio: invoice.invoiceNumber });
    });

    it('la descarga del libro (reportes) agrega Proveedor y Factura al final', async () => {
        const { product, supplier, invoice } = await fixtures('II');
        await entradaPorFactura(invoice.id, product.id, 30);
        const entry = await entradaPorFactura(invoice.id, product.id, 5);
        await inventoryService.cancelEntry({
            entryId: entry.id,
            reason: 'Duplicada por error',
            userId: 'u1',
            roleSlug: 'admin',
        });

        const keys = libroControlados.columns.map((column) => column.key);
        expect(keys.slice(-2)).toEqual(['supplier', 'invoice']);
        expect(libroControlados.columns.slice(-2).map((column) => column.header))
            .toEqual(['Proveedor', 'Factura']);

        const data = await libroControlados.load({ query: {}, now: new Date(), roleSlug: 'admin' });
        const mine = data.rows.filter((row) => row.product === product.name);
        expect(mine.map((row) => [row.movement, row.quantity])).toEqual([
            ['Entrada', 30],
            ['Entrada', 5],
            ['Cancelación de entrada', -5],
        ]);
        expect(mine[0]).toMatchObject({ supplier: supplier.name, invoice: invoice.invoiceNumber });
    });

    it('las etiquetas de movimiento son las que filtra el panel', () => {
        expect(controlledService.LEDGER_TYPE_LABELS).toEqual({
            sale: 'Venta',
            void: 'Anulación',
            return: 'Devolución',
            entry: 'Entrada',
            entry_cancel: 'Cancelación de entrada',
            exit_waste: 'Merma',
            exit_expiry: 'Caducidad',
        });
    });
});
