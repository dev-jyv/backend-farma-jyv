import { readFileSync } from 'fs';
import { join } from 'path';
import { Timestamp } from 'firebase-admin/firestore';
import { directInventoryEntrySchema, inventoryEntrySchema } from '../src/schemas';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as entriesRepo from '../src/repositories/inventory-entries.repository';
import { runIdempotentEntry } from '../src/services/entry-idempotency.service';
import * as inventoryService from '../src/services/inventory.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { AppError, badRequest } from '../src/utils/errors';
import { db } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const HACE_UNA_HORA = () => new Date(Date.now() - 60 * 60 * 1000);
const KEYS = 'stockEntryIdempotencyKeys';

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
    const nuevo = (overrides: Record<string, unknown> = {}) => ({
        name: unique('Nuevo'),
        sku: unique('SKU-NUEVO'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 25,
        minStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        ...overrides,
    });
    return { category, product, supplier, invoice, nuevo };
};

const stockOf = async (productId: string) =>
    (await productsRepo.getProductById(productId))!.totalStock;

const productsWithSku = async (sku: string) =>
    (await db().collection('products').where('sku', '==', sku).get()).docs;

const keyRef = (userId: string, key: string) => db().collection(KEYS).doc(`${userId}:${key}`);

/**
 * Deja la reserva como si el último intento hubiera sido hace una hora. La
 * reserva sigue siendo anterior al alta del producto, como en la vida real.
 */
const envejecer = async (userId: string, key: string): Promise<number> => {
    const pasado = Timestamp.fromDate(HACE_UNA_HORA());
    await keyRef(userId, key).update({ reservedAt: pasado, attemptAt: pasado });
    return pasado.toMillis();
};

const partidaDirecta = (product: unknown, lotNumber: string, quantity = 1) => ({
    product: product as never,
    lotNumber,
    expiryDate: '2030-01-31',
    quantity,
});

const altaEnLinea = async () => {
    const f = await fixtures();
    const producto = f.nuevo();
    const entrada = {
        invoiceId: f.invoice.id,
        lotNumber: unique('LOTE'),
        expiryDate: '2030-01-31',
        quantity: 7,
        product: producto as never,
        userId: 'uid-cajero',
        roleSlug: 'cashier',
        idempotencyKey: unique('entrada'),
    };
    return { ...f, producto, entrada };
};

describe('createStockEntry: producto en línea sin huérfanos (SPEC 55)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('el primer intento truena con 5xx tras el alta; el 2.º y el 3.º adoptan el mismo producto',
        async () => {
            const { entrada, producto } = await altaEnLinea();
            const spy = jest.spyOn(inventoryService, 'recordEntry')
                .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'))
                .mockRejectedValueOnce(new AppError(503, 'UNAVAILABLE', 'No disponible'));

            await expect(stockEntriesService.createStockEntry(entrada))
                .rejects.toThrow('DEADLINE_EXCEEDED');
            const [creado] = await productsWithSku(producto.sku);
            const reserva = (await keyRef('uid-cajero', entrada.idempotencyKey).get()).data()!;
            expect(reserva.productId).toBe(creado.id);
            const createdAt = (reserva.createdAt as Timestamp).toMillis();

            const marca = await envejecer('uid-cajero', entrada.idempotencyKey);
            await expect(stockEntriesService.createStockEntry(entrada))
                .rejects.toThrow('No disponible');
            // Retomar no reescribe `reservedAt` ni `createdAt` (SPEC 55).
            const retomada = (await keyRef('uid-cajero', entrada.idempotencyKey).get()).data()!;
            expect((retomada.reservedAt as Timestamp).toMillis()).toBe(marca);
            expect((retomada.createdAt as Timestamp).toMillis()).toBe(createdAt);
            spy.mockRestore();

            await envejecer('uid-cajero', entrada.idempotencyKey);
            const tercera = await stockEntriesService.createStockEntry(entrada);
            const cuarta = await stockEntriesService.createStockEntry(entrada);

            expect(await productsWithSku(producto.sku)).toHaveLength(1);
            expect(tercera.product.id).toBe(creado.id);
            expect(cuarta.entry.id).toBe(tercera.entry.id);
            expect(await stockOf(creado.id)).toBe(7);
            expect(await entriesRepo.listInventoryEntries({ invoiceId: entrada.invoiceId }))
                .toHaveLength(1);
            const final = (await keyRef('uid-cajero', entrada.idempotencyKey).get()).data()!;
            expect((final.createdAt as Timestamp).toMillis()).toBe(createdAt);
            expect(final.entryId).toBe(tercera.entry.id);
        });

    it('cae entre el alta y la anotación: el reintento lo adopta por SKU y reservedAt estable',
        async () => {
            const { entrada, producto } = await altaEnLinea();
            const spy = jest.spyOn(inventoryService, 'recordEntry')
                .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'))
                .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'));

            await expect(stockEntriesService.createStockEntry(entrada)).rejects.toThrow();
            const ref = keyRef('uid-cajero', entrada.idempotencyKey);
            // Como si la función hubiera muerto antes de anotar el producto.
            const { productId: _anotado, ...sinProducto } = (await ref.get()).data()!;
            await ref.set(sinProducto);
            await ref.update({
                reservedAt: Timestamp.fromDate(new Date(Date.now() - 20 * 60 * 1000)),
                attemptAt: Timestamp.fromDate(new Date(Date.now() - 20 * 60 * 1000)),
            });
            const marca = ((await ref.get()).data()!.reservedAt as Timestamp).toMillis();

            await expect(stockEntriesService.createStockEntry(entrada)).rejects.toThrow();
            spy.mockRestore();
            // El segundo intento anotó el producto adoptado y no movió `reservedAt`.
            const tras = (await ref.get()).data()!;
            expect((tras.reservedAt as Timestamp).toMillis()).toBe(marca);
            expect(tras.productId).toBeDefined();

            await envejecer('uid-cajero', entrada.idempotencyKey);
            await stockEntriesService.createStockEntry(entrada);

            const productos = await productsWithSku(producto.sku);
            expect(productos).toHaveLength(1);
            expect(await stockOf(productos[0].id)).toBe(7);
        });

    it('proveedor desactivado: 400 antes de crear el producto y la llave se libera', async () => {
        const { entrada, producto, supplier } = await altaEnLinea();
        await suppliersRepo.updateSupplier(supplier.id, { isActive: false });

        await expect(stockEntriesService.createStockEntry(entrada))
            .rejects.toThrow('El proveedor no está activo');

        expect(await productsWithSku(producto.sku)).toHaveLength(0);
        expect((await keyRef('uid-cajero', entrada.idempotencyKey).get()).exists).toBe(false);

        await suppliersRepo.updateSupplier(supplier.id, { isActive: true });
        const ok = await stockEntriesService.createStockEntry(entrada);
        expect(await stockOf(ok.product.id)).toBe(7);
    });

    it('SKU ya ocupado: 409 sin crear nada y la llave se libera', async () => {
        const { entrada, product } = await altaEnLinea();
        const choca = { ...entrada, product: { ...(entrada.product as object), sku: product.sku } };

        await expect(stockEntriesService.createStockEntry(choca as never))
            .rejects.toThrow('Ya existe un producto con ese SKU');
        expect((await keyRef('uid-cajero', entrada.idempotencyKey).get()).exists).toBe(false);
    });

    it('un rechazo de negocio después del alta conserva el producto: el reintento no choca',
        async () => {
            const { entrada, producto } = await altaEnLinea();
            jest.spyOn(inventoryService, 'recordEntry')
                .mockRejectedValueOnce(badRequest('El proveedor no está activo'));

            await expect(stockEntriesService.createStockEntry(entrada))
                .rejects.toThrow('El proveedor no está activo');
            const llave = (await keyRef('uid-cajero', entrada.idempotencyKey).get()).data()!;
            expect(llave.released).toBe(true);
            jest.restoreAllMocks();

            // Sin esperar los 10 minutos: la llave quedó liberada.
            const ok = await stockEntriesService.createStockEntry(entrada);

            expect(await productsWithSku(producto.sku)).toHaveLength(1);
            expect(ok.product.id).toBe(llave.productId);
            expect(await stockOf(ok.product.id)).toBe(7);
        });
});

describe('createStockEntry: emparejamiento por llave (SPEC 55)', () => {
    it('dos partidas iguales con llaves distintas, la primera con reserva vieja: entran las dos',
        async () => {
            const { product, invoice } = await fixtures();
            const partida = {
                invoiceId: invoice.id,
                lotNumber: 'LOTE-GEMELO',
                expiryDate: '2030-01-31',
                quantity: 5,
                productId: product.id,
                userId: 'uid-cajero',
                roleSlug: 'cashier',
            };
            const primera = unique('primera');
            await keyRef('uid-cajero', primera).set({
                userId: 'uid-cajero',
                createdAt: HACE_UNA_HORA(),
                reservedAt: HACE_UNA_HORA(),
            });
            const segunda = await stockEntriesService.createStockEntry({
                ...partida,
                idempotencyKey: unique('segunda'),
            });

            const reintento = await stockEntriesService.createStockEntry({
                ...partida,
                idempotencyKey: primera,
            });

            expect(reintento.entry.id).not.toBe(segunda.entry.id);
            expect(await stockOf(product.id)).toBe(10);
        });

    it('la entrada guarda su llave y la llave expira a los 30 días', async () => {
        const { product, invoice } = await fixtures();
        const key = unique('entrada');
        const antes = Date.now();

        const { entry } = await stockEntriesService.createStockEntry({
            invoiceId: invoice.id,
            lotNumber: 'LOTE-TTL',
            expiryDate: '2030-01-31',
            quantity: 1,
            productId: product.id,
            userId: 'uid-cajero',
            idempotencyKey: key,
        });

        expect((await entriesRepo.getInventoryEntryById(entry.id))?.idempotencyKey).toBe(key);
        const llave = (await keyRef('uid-cajero', key).get()).data()!;
        const dias = ((llave.expiresAt as Timestamp).toMillis() - antes) / 86_400_000;
        expect(dias).toBeGreaterThan(29.9);
        expect(dias).toBeLessThan(30.1);
        expect(llave.reservedAt).toBeInstanceOf(Timestamp);
    });

    it('sin llave la entrada no guarda idempotencyKey', async () => {
        const { product, invoice } = await fixtures();
        const { entry } = await stockEntriesService.createStockEntry({
            invoiceId: invoice.id,
            lotNumber: 'LOTE-SIN',
            expiryDate: '2030-01-31',
            quantity: 1,
            productId: product.id,
            userId: 'uid-cajero',
        });
        expect((await entriesRepo.getInventoryEntryById(entry.id))?.idempotencyKey)
            .toBeUndefined();
    });
});

describe('runIdempotentEntry: liberar solo ante un rechazo de negocio (SPEC 55)', () => {
    const correr = (key: string, run: () => Promise<never>) => runIdempotentEntry({
        userId: 'u1',
        scope: 'invoice-entry',
        key,
        releaseOnFailure: true,
        run,
    });

    it('un error que no es AppError conserva la llave', async () => {
        const key = unique('llave');
        await expect(correr(key, () => Promise.reject(new Error('DEADLINE_EXCEEDED'))))
            .rejects.toThrow('DEADLINE_EXCEEDED');
        await expect(correr(key, () => Promise.reject(badRequest('no debería correr'))))
            .rejects.toThrow(/quedó a medias/);
    });

    it('un AppError 5xx conserva la llave', async () => {
        const key = unique('llave');
        await expect(correr(key, () => Promise.reject(new AppError(500, 'X', 'falla'))))
            .rejects.toThrow('falla');
        expect((await db().collection(KEYS).doc(`u1:invoice-entry:${key}`).get()).exists)
            .toBe(true);
    });

    it('un AppError 4xx la libera', async () => {
        const key = unique('llave');
        await expect(correr(key, () => Promise.reject(badRequest('mal'))))
            .rejects.toThrow('mal');
        expect((await db().collection(KEYS).doc(`u1:invoice-entry:${key}`).get()).exists)
            .toBe(false);
    });

    it('la llave lleva expiresAt a 30 días', async () => {
        const f = await fixtures();
        const key = unique('llave');
        const antes = Date.now();
        await runIdempotentEntry({
            userId: 'u1',
            scope: 'invoice-entry',
            key,
            releaseOnFailure: true,
            run: () => inventoryService.recordEntry({
                invoiceId: f.invoice.id,
                items: [{
                    productId: f.product.id,
                    lotNumber: 'L-TTL',
                    expiryDate: '2030-01-31',
                    quantity: 1,
                }],
                userId: 'u1',
            }),
        });
        const llave = (await db().collection(KEYS).doc(`u1:invoice-entry:${key}`).get()).data()!;
        const dias = ((llave.expiresAt as Timestamp).toMillis() - antes) / 86_400_000;
        expect(Math.round(dias)).toBe(30);
    });
});

describe('recordDirectEntry: unicidad de todos los productos en línea (SPEC 55)', () => {
    it('si el segundo producto choca por SKU, el primero no se crea', async () => {
        const { supplier, product, nuevo } = await fixtures();
        const primero = nuevo();

        await expect(inventoryService.recordDirectEntry({
            supplierId: supplier.id,
            userId: 'u1',
            items: [
                partidaDirecta(primero, 'L1'),
                partidaDirecta(nuevo({ sku: product.sku }), 'L2'),
            ],
        })).rejects.toThrow('Ya existe un producto con ese SKU');

        expect(await productsWithSku(primero.sku)).toHaveLength(0);
    });

    it('dos productos en línea con el mismo SKU entre sí: 409 sin crear ninguno', async () => {
        const { supplier, nuevo } = await fixtures();
        const sku = unique('SKU-REPETIDO');

        await expect(inventoryService.recordDirectEntry({
            supplierId: supplier.id,
            userId: 'u1',
            items: [
                partidaDirecta(nuevo({ sku }), 'L1'),
                partidaDirecta(nuevo({ sku }), 'L2'),
            ],
        })).rejects.toThrow('mismo SKU');

        expect(await productsWithSku(sku)).toHaveLength(0);
    });

    it('categoría inexistente en el segundo producto: no deja el primero', async () => {
        const { supplier, nuevo } = await fixtures();
        const primero = nuevo();

        await expect(inventoryService.recordDirectEntry({
            supplierId: supplier.id,
            userId: 'u1',
            items: [
                partidaDirecta(primero, 'L1'),
                partidaDirecta(nuevo({ categoryId: 'no-existe' }), 'L2'),
            ],
        })).rejects.toThrow('Categoría no encontrado');

        expect(await productsWithSku(primero.sku)).toHaveLength(0);
    });

    it('todo válido: crea los productos y la entrada', async () => {
        const { supplier, nuevo } = await fixtures();
        const a = nuevo();
        const b = nuevo();

        const entry = await inventoryService.recordDirectEntry({
            supplierId: supplier.id,
            userId: 'u1',
            items: [
                partidaDirecta(a, 'L1', 2),
                partidaDirecta(b, 'L2', 3),
            ],
        });

        expect(entry.items).toHaveLength(2);
        expect(await productsWithSku(a.sku)).toHaveLength(1);
        expect(await productsWithSku(b.sku)).toHaveLength(1);
    });
});

describe('schemas de entradas: tope de 200 partidas (SPEC 55)', () => {
    const partida = {
        productId: 'p1',
        expiryDate: '2030-01-31',
        quantity: 1,
        lotNumber: 'L1',
    };
    const muchas = (n: number) => Array.from({ length: n }, () => partida);

    it('inventoryEntrySchema acepta 200 y rechaza 201', () => {
        expect(inventoryEntrySchema.safeParse({ invoiceId: 'f1', products: muchas(200) }).success)
            .toBe(true);
        expect(inventoryEntrySchema.safeParse({ invoiceId: 'f1', products: muchas(201) }).success)
            .toBe(false);
        expect(inventoryEntrySchema.safeParse({ invoiceId: 'f1', items: muchas(201) }).success)
            .toBe(false);
    });

    it('directInventoryEntrySchema acepta 200 y rechaza 201', () => {
        expect(directInventoryEntrySchema.safeParse({ supplierId: 's1', items: muchas(200) })
            .success).toBe(true);
        expect(directInventoryEntrySchema.safeParse({ supplierId: 's1', items: muchas(201) })
            .success).toBe(false);
    });
});

describe('firestore.indexes.json: TTL de stockEntryIdempotencyKeys (SPEC 55)', () => {
    it('declara la política TTL sobre expiresAt sin índices de campo', () => {
        const config = JSON.parse(
            readFileSync(join(__dirname, '..', '..', 'firestore.indexes.json'), 'utf8'),
        ) as { fieldOverrides: Array<Record<string, unknown>> };
        expect(config.fieldOverrides).toContainEqual({
            collectionGroup: 'stockEntryIdempotencyKeys',
            fieldPath: 'expiresAt',
            ttl: true,
            indexes: [],
        });
    });
});
