import { Timestamp } from 'firebase-admin/firestore';
import { AppExceptionFilter } from '../src/common/app-exception.filter';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { backfillProductNameKey } from '../src/scripts/backfill-denormalized';
import * as productsService from '../src/services/products.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { AppError } from '../src/utils/errors';
import { db } from '../src/utils/firestore';
import { isSameProduct, productNameKey } from '../src/utils/product-match';

/**
 * SPEC 60: productos sin duplicados entre cajas. `nameKey` único entre activos,
 * códigos `PRODUCT_*` con `details.existing`, adopción en la entrada de la caja y
 * backfill.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const actor = { userId: 'uid-admin', roleSlug: 'admin' };

const fixtures = async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
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
    const producto = (overrides: Record<string, unknown> = {}) => ({
        name: unique('Prod'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 30,
        minStock: 0,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        ...overrides,
    });
    return { category, supplier, invoice, producto };
};

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
    const error = await promise.then(
        () => { throw new Error('Se esperaba un rechazo'); },
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
};

/** Respuesta HTTP que arma el filtro global para un error. */
const httpBody = (error: unknown): { status: number; body: Record<string, unknown> } => {
    let status = 0;
    let body: Record<string, unknown> = {};
    const response = {
        status: (code: number) => {
            status = code;
            return response;
        },
        json: (payload: Record<string, unknown>) => {
            body = payload;
        },
    };
    const host = {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
    };
    new AppExceptionFilter().catch(error, host as never);
    return { status, body };
};

const productsWithSku = async (sku: string) =>
    (await db().collection('products').where('sku', '==', sku).get()).docs;

describe('productNameKey (copia de la regla del POS)', () => {
    it('"Paracetamol 500 mg" y "paracetamol  500MG" son el mismo nombre', () => {
        expect(productNameKey('Paracetamol 500 mg')).toBe(productNameKey('paracetamol  500MG'));
        expect(productNameKey('Paracetamol', '500 mg')).toBe('paracetamol 500mg');
        expect(productNameKey('Ácido  fólico', '5 MG')).toBe('acido folico 5mg');
    });

    it('la concentración distingue: 500 mg no es 1 g', () => {
        expect(productNameKey('Paracetamol', '500 mg'))
            .not.toBe(productNameKey('Paracetamol', '1 g'));
    });

    it('isSameProduct: código de barras si los dos lo tienen, si no el nombre', () => {
        const local = { name: 'Paracetamol 500 mg', barcode: '750100' };
        expect(isSameProduct(local, { name: 'Otro nombre', barcode: '750100' })).toBe(true);
        expect(isSameProduct(local, { name: 'paracetamol 500MG', barcode: '750999' }))
            .toBe(false);
        expect(isSameProduct(local, { name: 'paracetamol  500MG' })).toBe(true);
        expect(isSameProduct({ name: '' }, { name: '' })).toBe(false);
    });
});

describe('unicidad de nameKey en el catálogo', () => {
    it('"Paracetamol 500 mg" y "paracetamol  500MG" chocan: 409 PRODUCT_NAME_TAKEN', async () => {
        const { producto } = await fixtures();
        const base = unique('Paracetamol');
        const primero = await productsService.createProduct(
            producto({ name: `${base} 500 mg`, barcode: unique('750') }),
        );
        expect(primero.nameKey).toBe(productNameKey(`${base} 500 mg`));

        const error = await rejection(productsService.createProduct(
            producto({ name: `${base.toLowerCase()}  500MG` }),
        ));
        expect(error).toMatchObject({
            statusCode: 409,
            message: 'Ya existe un producto con ese nombre',
            syncCode: 'PRODUCT_NAME_TAKEN',
        });
        expect(error.details).toEqual({
            existing: {
                id: primero.id,
                name: primero.name,
                sku: primero.sku,
                barcode: primero.barcode,
            },
        });

        // Lo que recibe la caja: `details.code` y `details.existing`.
        const { status, body } = httpBody(error);
        expect(status).toBe(409);
        expect(body.error).toMatchObject({
            code: 'CONFLICT',
            message: 'Ya existe un producto con ese nombre',
            details: {
                code: 'PRODUCT_NAME_TAKEN',
                retryable: false,
                existing: { id: primero.id },
            },
        });
    });

    it('también con la concentración en su campo', async () => {
        const { producto } = await fixtures();
        const nombre = unique('Ibuprofeno');
        await productsService.createProduct(producto({ name: nombre, concentration: '400 mg' }));
        const error = await rejection(productsService.createProduct(
            producto({ name: nombre.toUpperCase(), concentration: '400MG' }),
        ));
        expect(error.syncCode).toBe('PRODUCT_NAME_TAKEN');
    });

    it('mismo nombre y distinta concentración no chocan', async () => {
        const { producto } = await fixtures();
        const nombre = unique('Amoxicilina');
        await productsService.createProduct(producto({ name: nombre, concentration: '500 mg' }));
        const otro = await productsService.createProduct(
            producto({ name: nombre, concentration: '250 mg' }),
        );
        expect(otro.nameKey).toBe(productNameKey(nombre, '250 mg'));
    });

    it('un producto inactivo con el mismo nombre no choca', async () => {
        const { producto } = await fixtures();
        const nombre = unique('Loratadina');
        const viejo = await productsService.createProduct(producto({ name: nombre }));
        await productsService.deleteProduct(viejo.id, actor);

        const nuevo = await productsService.createProduct(producto({ name: nombre }));
        expect(nuevo.id).not.toBe(viejo.id);

        // Reactivar el viejo sí choca: volvería a haber dos activos iguales.
        const error = await rejection(
            productsService.updateProduct(viejo.id, { isActive: true }, actor),
        );
        expect(error.syncCode).toBe('PRODUCT_NAME_TAKEN');
        expect(error.details).toMatchObject({ existing: { id: nuevo.id } });
    });

    it('sin nameKey (anterior al backfill) se compara por el nombre exacto', async () => {
        const { producto } = await fixtures();
        const nombre = unique('Naproxeno');
        const legacyRef = db().collection('products').doc();
        await legacyRef.set({
            ...producto({ name: nombre }),
            isActive: true,
            totalStock: 0,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });

        const error = await rejection(productsService.createProduct(producto({ name: nombre })));
        expect(error).toMatchObject({ syncCode: 'PRODUCT_NAME_TAKEN' });
        expect(error.details).toMatchObject({ existing: { id: legacyRef.id } });
    });

    it('renombrar hacia un nombre ocupado choca; un cambio de precio no', async () => {
        const { producto } = await fixtures();
        const nombre = unique('Omeprazol');
        const a = await productsService.createProduct(producto({ name: nombre }));
        const b = await productsService.createProduct(producto({ name: unique('Otro') }));

        const error = await rejection(productsService.updateProduct(
            b.id, { name: `  ${nombre.toUpperCase()} ` }, actor,
        ));
        expect(error.syncCode).toBe('PRODUCT_NAME_TAKEN');
        expect(error.details).toMatchObject({ existing: { id: a.id } });

        // Duplicado previo (dos activos con el mismo nombre, anteriores a SPEC 60):
        // cambiarle el precio a uno no se rechaza, y de paso queda con nameKey.
        const legacyRef = db().collection('products').doc();
        await legacyRef.set({
            ...producto({ name: nombre }),
            isActive: true,
            totalStock: 0,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });
        const actualizado = await productsService.updateProduct(
            legacyRef.id, { salePrice: 44 }, actor,
        );
        expect(actualizado.salePrice).toBe(44);
        expect((await legacyRef.get()).data()!.nameKey).toBe(productNameKey(nombre));
    });

    it('un SKU ocupado responde PRODUCT_SKU_TAKEN con el existente', async () => {
        const { producto } = await fixtures();
        const primero = await productsService.createProduct(producto());
        const error = await rejection(
            productsService.createProduct(producto({ sku: primero.sku })),
        );
        expect(error).toMatchObject({
            statusCode: 409,
            message: 'Ya existe un producto con ese SKU',
            syncCode: 'PRODUCT_SKU_TAKEN',
        });
        expect(error.details).toEqual({
            existing: { id: primero.id, name: primero.name, sku: primero.sku, barcode: null },
        });
    });
});

describe('entrada de la caja con un producto que ya existe (adopción)', () => {
    const entrada = (invoiceId: string, product: Record<string, unknown>, overrides = {}) => ({
        invoiceId,
        lotNumber: unique('L'),
        expiryDate: '2031-03-31',
        quantity: 6,
        costPrice: 12,
        product: product as never,
        userId: 'uid-cajero',
        roleSlug: 'cashier',
        idempotencyKey: unique('k'),
        deviceId: unique('caja'),
        ...overrides,
    });

    it('SKU existente y mismo código de barras: adopta el producto y aplica la entrada',
        async () => {
            const { invoice, producto } = await fixtures();
            const barcode = unique('750');
            const existente = await productsService.createProduct(
                producto({ barcode, salePrice: 30 }),
            );

            // La otra caja lo dio de alta sin red con otro nombre y otro precio.
            const result = await stockEntriesService.createStockEntry(entrada(
                invoice.id,
                producto({ sku: existente.sku, barcode, name: unique('Local'), salePrice: 99 }),
            ));

            expect(result.product.id).toBe(existente.id);
            expect(result.stock).toBe(6);
            expect(result.entry.items[0]).toMatchObject({ productId: existente.id, quantity: 6 });
            expect(await productsWithSku(existente.sku)).toHaveLength(1);

            // El catálogo no se reescribe desde la entrada: nombre y precio quedan.
            const tras = (await productsRepo.getProductById(existente.id))!;
            expect(tras).toMatchObject({ name: existente.name, salePrice: 30, totalStock: 6 });

            // Lo ignorado queda en la bitácora.
            const audits = await db().collection('auditLogs')
                .where('action', '==', 'product.adopted_on_entry')
                .where('entityId', '==', existente.id)
                .get();
            expect(audits.size).toBe(1);
            expect(audits.docs[0].data()).toMatchObject({
                userId: 'uid-cajero',
                changes: {
                    salePrice: { before: 30, after: 99 },
                    name: { before: existente.name },
                },
                metadata: { invoiceId: invoice.id },
            });
        });

    it('SKU existente y código de barras distinto: 409 PRODUCT_DUPLICATE sin tocar nada',
        async () => {
            const { invoice, producto } = await fixtures();
            const existente = await productsService.createProduct(
                producto({ barcode: unique('750') }),
            );
            const datos = entrada(
                invoice.id,
                producto({ sku: existente.sku, barcode: unique('751'), name: existente.name }),
            );

            const error = await rejection(stockEntriesService.createStockEntry(datos));
            expect(error).toMatchObject({
                statusCode: 409,
                syncCode: 'PRODUCT_DUPLICATE',
                retryable: false,
            });
            expect(error.message).toContain('Ya existe un producto con ese SKU');
            expect(error.message).toContain(existente.name);
            expect(error.details).toEqual({
                existing: {
                    id: existente.id,
                    name: existente.name,
                    sku: existente.sku,
                    barcode: existente.barcode,
                },
            });
            const { body } = httpBody(error);
            expect(body.error).toMatchObject({
                details: { code: 'PRODUCT_DUPLICATE', existing: { id: existente.id } },
            });

            expect((await productsRepo.getProductById(existente.id))!.totalStock).toBe(0);
            expect(await productsWithSku(existente.sku)).toHaveLength(1);
            // La llave se liberó: el rechazo no registró nada.
            const llave = await db().collection('stockEntryIdempotencyKeys')
                .doc(`${datos.deviceId}:${datos.idempotencyKey}`).get();
            expect(llave.exists).toBe(false);
        });

    it('SKU existente sin códigos de barras: adopta si el nombre normalizado coincide',
        async () => {
            const { invoice, producto } = await fixtures();
            const base = unique('Clonixinato');
            const existente = await productsService.createProduct(
                producto({ name: `${base} 100 mg` }),
            );

            const igual = await stockEntriesService.createStockEntry(entrada(
                invoice.id,
                producto({ sku: existente.sku, name: `${base.toUpperCase()}  100MG` }),
            ));
            expect(igual.product.id).toBe(existente.id);

            const otro = await rejection(stockEntriesService.createStockEntry(entrada(
                invoice.id,
                producto({ sku: existente.sku, name: unique('Distinto') }),
            )));
            expect(otro.syncCode).toBe('PRODUCT_DUPLICATE');
        });

    it('nombre ocupado con otro SKU por el mismo producto: lo adopta', async () => {
        const { invoice, producto } = await fixtures();
        const nombre = unique('Metformina');
        const existente = await productsService.createProduct(
            producto({ name: nombre, concentration: '850 mg' }),
        );

        const result = await stockEntriesService.createStockEntry(entrada(
            invoice.id,
            producto({ name: nombre.toLowerCase(), concentration: '850MG' }),
        ));
        expect(result.product.id).toBe(existente.id);
        expect(result.stock).toBe(6);
    });

    it('el mismo producto inactivo no se adopta: 409 PRODUCT_DUPLICATE', async () => {
        const { invoice, producto } = await fixtures();
        const barcode = unique('750');
        const existente = await productsService.createProduct(producto({ barcode }));
        await productsService.deleteProduct(existente.id, actor);

        const error = await rejection(stockEntriesService.createStockEntry(entrada(
            invoice.id,
            producto({ sku: existente.sku, barcode }),
        )));
        expect(error.syncCode).toBe('PRODUCT_DUPLICATE');
        expect(error.message).toContain('inactivo');
    });

    it('el reintento de una adopción no vuelve a sumar la partida', async () => {
        const { invoice, producto } = await fixtures();
        const barcode = unique('750');
        const existente = await productsService.createProduct(producto({ barcode }));
        const datos = entrada(invoice.id, producto({ sku: existente.sku, barcode }));

        const primera = await stockEntriesService.createStockEntry(datos);
        const segunda = await stockEntriesService.createStockEntry(datos);
        expect(segunda.entry.id).toBe(primera.entry.id);
        expect((await productsRepo.getProductById(existente.id))!.totalStock).toBe(6);
    });
});

describe('backfill de nameKey (backfill:denormalized --only=products)', () => {
    const legacy = async (name: string, concentration?: string, nameKey?: string) => {
        const ref = db().collection('products').doc();
        await ref.set({
            name,
            sku: unique('SKU'),
            ...(concentration ? { concentration } : {}),
            ...(nameKey ? { nameKey } : {}),
            isActive: true,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });
        return ref;
    };

    it('--dry-run reporta los nameKey a escribir sin escribir nada', async () => {
        const sinClave = await legacy('Paracetamol', '500 mg');
        const conClave = await legacy('Aspirina', undefined, 'aspirina');
        await legacy('paracetamol', '500MG');

        const plan = await backfillProductNameKey(db(), { dryRun: true, force: false });
        expect(plan.changes).toEqual(expect.arrayContaining([
            { id: sinClave.id, name: 'Paracetamol', nameKey: 'paracetamol 500mg' },
        ]));
        expect(plan.changes.map((change) => change.id)).not.toContain(conClave.id);
        expect(plan.updated).toBe(plan.changes.length);
        // Los dos Paracetamol activos comparten clave: se avisa, no se tocan.
        expect(plan.collisions).toBeGreaterThanOrEqual(1);
        expect((await sinClave.get()).data()!.nameKey).toBeUndefined();

        const real = await backfillProductNameKey(db(), { dryRun: false, force: false });
        expect(real.updated).toBe(plan.updated);
        expect((await sinClave.get()).data()!.nameKey).toBe('paracetamol 500mg');

        // Idempotente: una segunda corrida no tiene nada que escribir.
        const otra = await backfillProductNameKey(db(), { dryRun: true, force: false });
        expect(otra.changes).toEqual([]);
    });

    it('--force corrige un nameKey desactualizado', async () => {
        const ref = await legacy('Diclofenaco', '100 mg', 'viejo');
        const sinForce = await backfillProductNameKey(db(), { dryRun: true, force: false });
        expect(sinForce.changes.map((change) => change.id)).not.toContain(ref.id);

        await backfillProductNameKey(db(), { dryRun: false, force: true });
        expect((await ref.get()).data()!.nameKey).toBe('diclofenaco 100mg');
    });
});
