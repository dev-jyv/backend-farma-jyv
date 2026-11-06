import 'reflect-metadata';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpException } from '@nestjs/common';
import { AppExceptionFilter } from '../src/common/app-exception.filter';
import { InventoryController } from '../src/modules/inventory/inventory.controller';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { cancelInventoryEntrySchema, createStockEntrySchema } from '../src/schemas';
import * as inventoryService from '../src/services/inventory.service';
import * as invoicesService from '../src/services/invoices.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { AuthUser, Batch } from '../src/types';
import { AppError } from '../src/utils/errors';
import { db } from '../src/utils/firestore';
import { normalizeInvoiceFolio } from '../src/utils/invoice-folio';

/**
 * SPEC 58: factura recapturada detectada (409 `ENTRY_POSSIBLE_DUPLICATE`),
 * cancelación de entrada con contramovimiento y folio de factura normalizado.
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
            totalAmount: 500,
            hasInvoice: false,
        },
        'test-user',
    );
    return { category, product, supplier, invoice };
};

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
    const error = await promise.then(
        () => { throw new Error('Se esperaba un rechazo'); },
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
};

const batchesOf = async (productId: string): Promise<Batch[]> =>
    (await db().collection('batches').where('productId', '==', productId).get())
        .docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Batch);

const stockOf = async (productId: string) =>
    (await productsRepo.getProductById(productId))!.totalStock;

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

describe('partida repetida con otra llave (ENTRY_POSSIBLE_DUPLICATE)', () => {
    const partida = (invoiceId: string, productId: string, overrides = {}) => ({
        invoiceId,
        productId,
        lotNumber: 'L-DUP',
        expiryDate: '2030-01-31',
        quantity: 12,
        costPrice: 8,
        userId: 'uid-cajero',
        roleSlug: 'cashier',
        idempotencyKey: unique('k'),
        ...overrides,
    });

    it('la segunda entrada idéntica con otra llave responde 409; con confirmDuplicate entra',
        async () => {
            const { product, invoice } = await fixtures();
            const primera = await stockEntriesService.createStockEntry(
                partida(invoice.id, product.id),
            );

            const segunda = partida(invoice.id, product.id, { lotNumber: 'l-dup' });
            const error = await rejection(stockEntriesService.createStockEntry(segunda));
            expect(error).toMatchObject({
                statusCode: 409,
                syncCode: 'ENTRY_POSSIBLE_DUPLICATE',
                retryable: false,
            });
            expect(error.details).toMatchObject({ existing: { entryId: primera.entry.id } });
            const existing = error.details?.existing as { createdAt?: unknown };
            expect(new Date(String(existing.createdAt)).getTime())
                .toBe(primera.entry.createdAt.toMillis());

            // Lo que recibe la caja: `details.code` más el dato de la existente.
            const { status, body } = httpBody(error);
            expect(status).toBe(409);
            expect(body.error).toMatchObject({
                code: 'CONFLICT',
                details: {
                    code: 'ENTRY_POSSIBLE_DUPLICATE',
                    retryable: false,
                    existing: { entryId: primera.entry.id },
                },
            });

            expect(await stockOf(product.id)).toBe(12);
            // La llave se liberó: el reenvío confirmado con la misma llave entra.
            const confirmada = await stockEntriesService.createStockEntry({
                ...segunda,
                confirmDuplicate: true,
            });
            expect(confirmada.entry.id).not.toBe(primera.entry.id);
            expect(await stockOf(product.id)).toBe(24);
            expect(await batchesOf(product.id)).toHaveLength(1);
        });

    it('también choca contra una captura manual sin llave', async () => {
        const { product, invoice } = await fixtures();
        await inventoryService.recordEntry({
            invoiceId: invoice.id,
            userId: 'uid-panel',
            items: [{ productId: product.id, lotNumber: 'L-DUP', expiryDate: '2030-01-31',
                quantity: 12 }],
        });
        const error = await rejection(
            stockEntriesService.createStockEntry(partida(invoice.id, product.id)),
        );
        expect(error.syncCode).toBe('ENTRY_POSSIBLE_DUPLICATE');
    });

    it('otra cantidad, otro lote o una entrada cancelada no son duplicado', async () => {
        const { product, invoice } = await fixtures();
        const primera = await stockEntriesService.createStockEntry(
            partida(invoice.id, product.id),
        );
        await stockEntriesService.createStockEntry(
            partida(invoice.id, product.id, { quantity: 5 }),
        );
        await stockEntriesService.createStockEntry(
            partida(invoice.id, product.id, { lotNumber: 'OTRO' }),
        );

        await inventoryService.cancelEntry({
            entryId: primera.entry.id,
            reason: 'Factura capturada dos veces',
            userId: 'uid-admin',
            roleSlug: 'admin',
        });
        await stockEntriesService.createStockEntry(partida(invoice.id, product.id));
        expect(await stockOf(product.id)).toBe(12 + 5 + 12);
    });

    it('el reintento con la misma llave devuelve la entrada, no el aviso', async () => {
        const { product, invoice } = await fixtures();
        const input = partida(invoice.id, product.id);
        const primera = await stockEntriesService.createStockEntry(input);
        const otra = await stockEntriesService.createStockEntry(input);
        expect(otra.entry.id).toBe(primera.entry.id);
        expect(await stockOf(product.id)).toBe(12);
    });

    it('el schema acepta confirmDuplicate', () => {
        const parsed = createStockEntrySchema.parse({
            invoiceId: 'inv-1',
            productId: 'p1',
            lotNumber: 'L1',
            expiryDate: '2030-01-31',
            quantity: 1,
            confirmDuplicate: true,
        });
        expect(parsed.confirmDuplicate).toBe(true);
    });
});

describe('cancelar una entrada', () => {
    const registrar = async () => {
        const f = await fixtures();
        const entry = await inventoryService.recordEntry({
            invoiceId: f.invoice.id,
            userId: 'uid-almacen',
            items: [
                { productId: f.product.id, lotNumber: 'C-1', expiryDate: '2030-01-31',
                    quantity: 10, costPrice: 5 },
                { productId: f.product.id, lotNumber: 'C-2', expiryDate: '2030-02-28',
                    quantity: 4, costPrice: 5 },
            ],
        });
        return { ...f, entry };
    };

    it('resta los lotes, escribe movimientos entry_cancel negativos y audita', async () => {
        const { product, entry } = await registrar();
        // Otra entrada suma al mismo lote: cancelar la primera solo quita lo suyo.
        await inventoryService.recordEntry({
            invoiceId: entry.invoiceId!,
            userId: 'uid-almacen',
            items: [{ productId: product.id, lotNumber: 'C-1', expiryDate: '2030-01-31',
                quantity: 3 }],
        });
        expect(await stockOf(product.id)).toBe(17);

        const cancelled = await inventoryService.cancelEntry({
            entryId: entry.id,
            reason: 'Foto y PDF de la misma factura',
            userId: 'uid-gerente',
            roleSlug: 'manager',
        });

        expect(cancelled).toMatchObject({
            id: entry.id,
            cancelledBy: 'uid-gerente',
            cancelReason: 'Foto y PDF de la misma factura',
        });
        expect(cancelled.cancelledAt).toBeInstanceOf(Timestamp);
        expect(await stockOf(product.id)).toBe(3);
        const quantities = Object.fromEntries(
            (await batchesOf(product.id)).map((batch) => [batch.lotNumber, batch.quantity]),
        );
        expect(quantities).toEqual({ 'C-1': 3, 'C-2': 0 });

        const movements = (await db().collection('stockMovements')
            .where('referenceId', '==', entry.id).get()).docs.map((doc) => doc.data());
        const reversals = movements.filter((movement) => movement.type === 'entry_cancel');
        expect(reversals.map((movement) => movement.quantity).sort()).toEqual([-10, -4]);
        expect(reversals.every((movement) => movement.reason ===
            'Foto y PDF de la misma factura')).toBe(true);

        const audit = await db().collection('auditLogs')
            .where('entityId', '==', entry.id).get();
        expect(audit.docs.map((doc) => doc.data())).toEqual([
            expect.objectContaining({
                action: 'inventory.entry_cancelled',
                entity: 'inventoryEntry',
                entityId: entry.id,
                userId: 'uid-gerente',
                roleSlug: 'manager',
            }),
        ]);

        // El listado de la factura la trae marcada (el panel la excluye de lo capturado).
        const { items } = await inventoryService.listEntries({ invoiceId: entry.invoiceId });
        expect(items.find((item) => item.id === entry.id)?.cancelReason)
            .toBe('Foto y PDF de la misma factura');
    });

    it('con piezas ya vendidas responde 400 y no cambia nada', async () => {
        const { product, entry } = await registrar();
        const [lote] = (await batchesOf(product.id)).filter((batch) => batch.lotNumber === 'C-2');
        // Se vendieron 3 de las 4 del lote C-2.
        await db().collection('batches').doc(lote.id).update({ quantity: 1 });

        const error = await rejection(inventoryService.cancelEntry({
            entryId: entry.id,
            reason: 'Captura equivocada',
            userId: 'uid-admin',
            roleSlug: 'admin',
        }));
        expect(error.statusCode).toBe(400);
        expect(error.message).toContain('C-2');

        expect(await stockOf(product.id)).toBe(14);
        const quantities = Object.fromEntries(
            (await batchesOf(product.id)).map((batch) => [batch.lotNumber, batch.quantity]),
        );
        expect(quantities).toEqual({ 'C-1': 10, 'C-2': 1 });
        const stored = (await db().collection('inventoryEntries').doc(entry.id).get()).data()!;
        expect(stored.cancelledAt).toBeUndefined();
        const reversals = (await db().collection('stockMovements')
            .where('referenceId', '==', entry.id).get())
            .docs.filter((doc) => doc.data().type === 'entry_cancel');
        expect(reversals).toHaveLength(0);
    });

    it('cancelar una entrada ya cancelada responde 409', async () => {
        const { entry } = await registrar();
        const input = {
            entryId: entry.id,
            reason: 'Captura duplicada',
            userId: 'uid-admin',
            roleSlug: 'admin',
        };
        await inventoryService.cancelEntry(input);
        const error = await rejection(inventoryService.cancelEntry(input));
        expect(error.statusCode).toBe(409);
    });

    it('solo admin o gerente; motivo de al menos 5 caracteres', async () => {
        const { entry } = await registrar();
        const error = await rejection(inventoryService.cancelEntry({
            entryId: entry.id,
            reason: 'Captura duplicada',
            userId: 'uid-cajero',
            roleSlug: 'cashier',
        }));
        expect(error.statusCode).toBe(403);
        expect(cancelInventoryEntrySchema.safeParse({ reason: ' abc ' }).success).toBe(false);
        expect(cancelInventoryEntrySchema.safeParse({ reason: 'Duplicada' }).success).toBe(true);
        await expect(inventoryService.cancelEntry({
            entryId: 'no-existe',
            reason: 'Captura duplicada',
            userId: 'uid-admin',
            roleSlug: 'admin',
        })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('la ruta es POST inventory/entries/:id/cancel con inventory:write', async () => {
        const { entry } = await registrar();
        const proto = InventoryController.prototype as unknown as Record<string, unknown>;
        expect(Reflect.getMetadata(PERMISSION_KEY, proto.cancelEntry as object))
            .toEqual({ area: 'inventory', level: 'write' });
        expect(Reflect.getMetadata('path', proto.cancelEntry as object))
            .toBe('entries/:id/cancel');

        const controller = new InventoryController();
        const user = {
            uid: 'uid-admin',
            role: { id: 'r', slug: 'admin', name: 'Admin' },
            permissions: [],
        } as unknown as AuthUser;
        const result = await controller.cancelEntry(
            { id: entry.id },
            { reason: 'Captura duplicada' },
            user,
        );
        expect(result.data).toMatchObject({ id: entry.id, cancelReason: 'Captura duplicada' });
    });
});

describe('folio de factura normalizado', () => {
    it('mayúsculas, sin espacios ni guiones y sin ceros a la izquierda en lo numérico', () => {
        expect(normalizeInvoiceFolio('A-0123')).toBe('A123');
        expect(normalizeInvoiceFolio('a123')).toBe('A123');
        expect(normalizeInvoiceFolio(' a 0 1 2 3 ')).toBe('A123');
        // Primero se quitan separadores; luego los ceros a la izquierda del tramo numérico.
        expect(normalizeInvoiceFolio('F-001-0007')).toBe('F10007');
        expect(normalizeInvoiceFolio('000')).toBe('0');
        expect(normalizeInvoiceFolio('B10')).toBe('B10');
    });

    const alta = (supplierId: string, invoiceNumber: string) => invoicesRepo.createInvoice(
        invoicesRepo.generateInvoiceId(),
        {
            supplierId,
            invoiceNumber,
            invoiceDate: Timestamp.now(),
            totalAmount: 100,
            hasInvoice: false,
        },
        'test-user',
    );

    it('"A-0123" y "a123" del mismo proveedor chocan; de otro proveedor no', async () => {
        const { supplier } = await fixtures();
        const otro = await suppliersRepo.createSupplier({ name: unique('Prov'), isActive: true });

        const primera = await alta(supplier.id, 'A-0123');
        expect(primera.folioKey).toBe('A123');
        const error = await rejection(alta(supplier.id, 'a123'));
        expect(error.statusCode).toBe(409);
        await expect(alta(otro.id, 'a123')).resolves.toMatchObject({ folioKey: 'A123' });
    });

    it('una factura anterior sin folioKey sigue comparándose por texto', async () => {
        const { supplier } = await fixtures();
        await db().collection('invoices').add({
            supplierId: supplier.id,
            invoiceNumber: 'Z-77',
            invoiceDate: Timestamp.now(),
            totalAmount: 10,
            hasInvoice: false,
        });
        expect((await rejection(alta(supplier.id, 'Z-77'))).statusCode).toBe(409);
        // Otra forma del mismo folio no se detecta contra la vieja: no tiene llave.
        await expect(alta(supplier.id, 'z77')).resolves.toMatchObject({ folioKey: 'Z77' });
    });

    it('createInvoice del servicio también rechaza el folio repetido', async () => {
        const { supplier } = await fixtures();
        await alta(supplier.id, 'FX-001');
        await expect(invoicesService.createInvoice({
            supplierId: supplier.id,
            invoiceNumber: 'fx 1',
            invoiceDate: '2026-11-01',
            totalAmount: 50,
            hasInvoice: false,
            userId: 'uid-admin',
        })).rejects.toMatchObject({ statusCode: 409 });
    });
});

it('HttpException sigue sin details de negocio', () => {
    const { body } = httpBody(new HttpException('x', 404));
    expect((body.error as Record<string, unknown>).details).toBeUndefined();
});
