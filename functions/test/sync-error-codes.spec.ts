import { HttpException, Logger } from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';
import { AppExceptionFilter } from '../src/common/app-exception.filter';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import {
    isRetryableSyncErrorCode,
    SYNC_ERROR_CODES,
    SyncErrorCode,
} from '../src/constants/sync-error-codes';
import { SalesController } from '../src/modules/sales/sales.controller';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { createStockEntrySchema } from '../src/schemas';
import * as inventoryService from '../src/services/inventory.service';
import * as salesService from '../src/services/sales.service';
import * as stockEntriesService from '../src/services/stock-entries.service';
import { AuthUser } from '../src/types';
import {
    AppError,
    badRequest,
    conflict,
    describeSyncError,
    notFound,
    withDefaultSyncCode,
} from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';

/**
 * SPEC 49: la caja decide reintentar, bloquear o conciliar por un código estable,
 * no por el texto del mensaje. Estas pruebas fijan el catálogo y el código de cada
 * rechazo que el POS distingue en `createSale`, `voidSale` y `createStockEntry`.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
    const error = await promise.then(
        () => { throw new Error('Se esperaba un rechazo'); },
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
};

const expectSyncCode = async (
    promise: Promise<unknown>,
    code: SyncErrorCode,
    retryable = false,
): Promise<AppError> => {
    const error = await rejection(promise);
    expect({ syncCode: error.syncCode, retryable: error.retryable })
        .toEqual({ syncCode: code, retryable });
    return error;
};

describe('catálogo de códigos de sincronización', () => {
    it('es exactamente el de la spec: el POS tiene una copia y deben coincidir', () => {
        expect([...SYNC_ERROR_CODES]).toEqual([
            'STOCK_INSUFFICIENT',
            'BATCH_EXPIRED',
            'PRODUCT_NOT_FOUND',
            'PRODUCT_INACTIVE',
            'SESSION_CLOSED',
            'SESSION_FORBIDDEN',
            'IDEMPOTENCY_CONFLICT',
            'VALIDATION',
            'DEFERRED',
            'ENTRY_IN_PROGRESS',
            'ENTRY_AMBIGUOUS',
            'ALREADY_VOIDED',
            'HAS_RETURNS',
            'VOID_FORBIDDEN',
            'INTERNAL',
        ]);
    });

    it('solo lo que aún no se decidió es reintentable', () => {
        expect(SYNC_ERROR_CODES.filter(isRetryableSyncErrorCode))
            .toEqual(['DEFERRED', 'ENTRY_IN_PROGRESS', 'INTERNAL']);
    });
});

describe('AppError con código de negocio', () => {
    it('conserva el código HTTP y agrega el de sincronización', () => {
        const error = badRequest('Stock insuficiente para X', 'STOCK_INSUFFICIENT');
        expect(error).toMatchObject({
            statusCode: 400,
            code: 'BAD_REQUEST',
            syncCode: 'STOCK_INSUFFICIENT',
            retryable: false,
        });
    });

    it('sin código: reintentable solo si es ≥ 500', () => {
        expect(badRequest('x').retryable).toBe(false);
        expect(new AppError(503, 'UNAVAILABLE', 'x').retryable).toBe(true);
    });

    it('withDefaultSyncCode etiqueta un 4xx mudo y respeta el que ya traía', () => {
        const original = notFound('Factura');
        const tagged = withDefaultSyncCode(original, 'VALIDATION') as AppError;
        expect(tagged).toBeInstanceOf(AppError);
        expect(tagged).toMatchObject({
            statusCode: 404,
            code: 'NOT_FOUND',
            message: 'Factura no encontrado',
            syncCode: 'VALIDATION',
        });
        expect(tagged.stack).toBe(original.stack);

        const ownCode = conflict('x', 'HAS_RETURNS');
        expect(withDefaultSyncCode(ownCode, 'VALIDATION')).toBe(ownCode);
        const internal = new AppError(502, 'UPSTREAM', 'x');
        expect(withDefaultSyncCode(internal, 'VALIDATION')).toBe(internal);
        const raw = new Error('ABORTED');
        expect(withDefaultSyncCode(raw, 'VALIDATION')).toBe(raw);
    });

    it('describeSyncError: no-AppError o ≥ 500 es INTERNAL reintentable', () => {
        expect(describeSyncError(new Error('10 ABORTED: Transaction lock timeout')))
            .toEqual({
                code: 'INTERNAL',
                retryable: true,
                message: '10 ABORTED: Transaction lock timeout',
            });
        expect(describeSyncError(new AppError(502, 'MP', 'Mercado Pago no responde', {
            syncCode: 'STOCK_INSUFFICIENT',
        }))).toMatchObject({ code: 'INTERNAL', retryable: true });
        expect(describeSyncError('cadena')).toEqual({
            code: 'INTERNAL',
            retryable: true,
            message: 'Error desconocido',
        });
        expect(describeSyncError(badRequest('x'))).toMatchObject({
            code: 'VALIDATION',
            retryable: false,
        });
        expect(describeSyncError(badRequest('x', 'SESSION_CLOSED'))).toMatchObject({
            code: 'SESSION_CLOSED',
            retryable: false,
        });
    });

    it('un payload que no pasa el esquema es VALIDATION', () => {
        const error = (() => {
            try {
                new ZodValidationPipe(createStockEntrySchema).transform({});
            } catch (caught) {
                return caught as AppError;
            }
            throw new Error('Se esperaba un rechazo');
        })();
        expect(error).toMatchObject({ statusCode: 400, syncCode: 'VALIDATION' });
    });
});

describe('AppExceptionFilter: error.details', () => {
    const buildHost = () => {
        const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const request = { method: 'POST', originalUrl: '/v1/sales/x/void' };
        const host = {
            switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
        };
        return { host: host as never, response };
    };

    afterEach(() => jest.restoreAllMocks());

    it('agrega details sin tocar code ni message', () => {
        const { host, response } = buildHost();
        new AppExceptionFilter()
            .catch(badRequest('La venta ya está anulada', 'ALREADY_VOIDED'), host);

        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith({
            error: {
                code: 'BAD_REQUEST',
                message: 'La venta ya está anulada',
                details: { code: 'ALREADY_VOIDED', retryable: false },
            },
        });
    });

    it('ENTRY_IN_PROGRESS viaja como 409 reintentable', () => {
        const { host, response } = buildHost();
        new AppExceptionFilter().catch(new AppError(409, 'CONFLICT', 'x', {
            syncCode: 'ENTRY_IN_PROGRESS',
        }), host);

        expect(response.status).toHaveBeenCalledWith(409);
        expect(response.json.mock.calls[0][0].error.details)
            .toEqual({ code: 'ENTRY_IN_PROGRESS', retryable: true });
    });

    it('un AppError sin código conserva el formato de siempre', () => {
        const { host, response } = buildHost();
        new AppExceptionFilter().catch(new AppError(404, 'NOT_FOUND', 'x'), host);

        expect(response.json).toHaveBeenCalledWith({
            error: { code: 'NOT_FOUND', message: 'x' },
        });
    });

    it('un error inesperado o un ≥ 500 sale INTERNAL reintentable', () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { host, response } = buildHost();
        const filter = new AppExceptionFilter();

        filter.catch(new Error('10 ABORTED: Transaction lock timeout'), host);
        filter.catch(new AppError(502, 'MERCADOPAGO_UNAVAILABLE', 'Servicio no disponible'), host);
        filter.catch(new HttpException('caída', 503), host);

        const details = response.json.mock.calls.map((call) => call[0].error.details);
        expect(details).toEqual([
            { code: 'INTERNAL', retryable: true },
            { code: 'INTERNAL', retryable: true },
            { code: 'INTERNAL', retryable: true },
        ]);
        expect(response.json.mock.calls[0][0].error).toMatchObject({
            code: 'INTERNAL_ERROR',
            message: 'Error interno del servidor',
        });
    });
});

// --- Fixtures de venta ---

const createProduct = async (overrides: { isActive?: boolean; hasIeps?: boolean } = {}) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: overrides.hasIeps ?? false,
        isActive: overrides.isActive ?? true,
        suppliers: [],
    });
};

const stock = async (productId: string, quantity: number, expiryDate = '2030-06-01') => {
    const batch = await batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp(expiryDate),
        quantity,
    });
    await productsRepo.updateProduct(productId, { totalStock: quantity });
    return batch;
};

const openSession = async (userId = 'cajero-a') =>
    cashSessionsRepo.createCashSession({
        openedBy: userId,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });

const saleInput = (productId: string, cashSessionId: string, quantity = 1) => ({
    items: [{ productId, quantity }],
    paymentMethod: 'cash' as const,
    amountReceived: 10 * quantity,
    cashSessionId,
    cashierId: 'cajero-a',
    roleSlug: 'cashier',
});

describe('createSale: código de cada rechazo', () => {
    it('STOCK_INSUFFICIENT', async () => {
        const product = await createProduct();
        await stock(product.id, 1);
        const session = await openSession();

        await expectSyncCode(
            salesService.createSale(saleInput(product.id, session.id, 2)),
            'STOCK_INSUFFICIENT',
        );
    });

    it('BATCH_EXPIRED', async () => {
        const product = await createProduct();
        await stock(product.id, 5, '2020-01-01');
        const session = await openSession();

        await expectSyncCode(
            salesService.createSale(saleInput(product.id, session.id)),
            'BATCH_EXPIRED',
        );
    });

    it('PRODUCT_NOT_FOUND, con el mismo mensaje de siempre', async () => {
        const session = await openSession();

        const error = await expectSyncCode(
            salesService.createSale(saleInput('no-existe', session.id)),
            'PRODUCT_NOT_FOUND',
        );
        expect(error.message).toBe('Producto no-existe no encontrado');
        expect(error.statusCode).toBe(404);
    });

    it('PRODUCT_INACTIVE: existe pero está desactivado', async () => {
        const product = await createProduct({ isActive: false });
        await stock(product.id, 5);
        const session = await openSession();

        const error = await expectSyncCode(
            salesService.createSale(saleInput(product.id, session.id)),
            'PRODUCT_INACTIVE',
        );
        expect(error.message).toBe(`Producto ${product.id} no encontrado`);
    });

    it('SESSION_CLOSED', async () => {
        const product = await createProduct();
        await stock(product.id, 5);
        const session = await openSession();
        await db().collection('cashSessions').doc(session.id)
            .update({ closedAt: Timestamp.now() });

        await expectSyncCode(
            salesService.createSale(saleInput(product.id, session.id)),
            'SESSION_CLOSED',
        );
    });

    it('SESSION_FORBIDDEN: turno de otro cajero', async () => {
        const product = await createProduct();
        await stock(product.id, 5);
        const session = await openSession('cajero-b');

        await expectSyncCode(
            salesService.createSale(saleInput(product.id, session.id)),
            'SESSION_FORBIDDEN',
        );
    });

    it('IDEMPOTENCY_CONFLICT: la misma llave con otro cobro', async () => {
        const product = await createProduct();
        await stock(product.id, 5);
        const session = await openSession();
        const idempotencyKey = unique('llave');

        await salesService.createSale({ ...saleInput(product.id, session.id), idempotencyKey });
        const error = await expectSyncCode(
            salesService.createSale({ ...saleInput(product.id, session.id, 2), idempotencyKey }),
            'IDEMPOTENCY_CONFLICT',
        );
        expect(error.statusCode).toBe(409);
    });

    it('VALIDATION: cualquier otro rechazo de negocio', async () => {
        const product = await createProduct({ hasIeps: true });
        await stock(product.id, 5);
        const session = await openSession();

        await expectSyncCode(
            salesService.createSale(saleInput(product.id, session.id)),
            'VALIDATION',
        );
        await expectSyncCode(
            salesService.createSale({ ...saleInput(product.id, session.id), items: [] }),
            'VALIDATION',
        );
    });
});

describe('voidSale: código de cada rechazo', () => {
    const sell = async (cashierId = 'cajero-a') => {
        const product = await createProduct();
        await stock(product.id, 5);
        const session = await openSession(cashierId);
        const sale = await salesService.createSale({
            ...saleInput(product.id, session.id),
            cashierId,
        });
        return { sale, session };
    };

    it('ALREADY_VOIDED', async () => {
        const { sale } = await sell();
        await salesService.voidSale(sale.id, 'cajero-a', 'cashier');

        await expectSyncCode(
            salesService.voidSale(sale.id, 'cajero-a', 'cashier'),
            'ALREADY_VOIDED',
        );
    });

    it('HAS_RETURNS', async () => {
        const { sale } = await sell();
        await db().collection('sales').doc(sale.id).update({ refundedTotal: 5 });

        await expectSyncCode(
            salesService.voidSale(sale.id, 'cajero-a', 'cashier'),
            'HAS_RETURNS',
        );
    });

    it('VOID_FORBIDDEN: turno ya cerrado y no es admin', async () => {
        const { sale, session } = await sell();
        await db().collection('cashSessions').doc(session.id)
            .update({ closedAt: Timestamp.now() });

        await expectSyncCode(
            salesService.voidSale(sale.id, 'cajero-a', 'cashier'),
            'VOID_FORBIDDEN',
        );
    });

    it('VOID_FORBIDDEN: el rol no puede anular', () => {
        let error: unknown;
        try {
            salesService.assertCanVoidSale({ role: { slug: 'custom' }, permissions: [] });
        } catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({ statusCode: 403, syncCode: 'VOID_FORBIDDEN' });
    });

    it('SESSION_FORBIDDEN: turno abierto de otro cajero', async () => {
        const { sale } = await sell('cajero-b');

        await expectSyncCode(
            salesService.voidSale(sale.id, 'cajero-a', 'cashier'),
            'SESSION_FORBIDDEN',
        );
    });

    it('VALIDATION: venta inexistente', async () => {
        await expectSyncCode(
            salesService.voidSale('no-existe', 'cajero-a', 'cashier'),
            'VALIDATION',
        );
    });
});

// --- Fixtures de entrada ---

const entryFixtures = async () => {
    const product = await createProduct();
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
        userId: 'uid-cajero',
        roleSlug: 'cashier',
        idempotencyKey: unique('entrada'),
    };
    return { product, invoice, entrada };
};

const reserve = (key: string, createdAt: Date) => db()
    .collection('stockEntryIdempotencyKeys')
    .doc(`uid-cajero:${key}`)
    .set({ userId: 'uid-cajero', createdAt });

describe('createStockEntry: código de cada rechazo', () => {
    it('ENTRY_IN_PROGRESS: reserva reciente sin entrada, 409 reintentable', async () => {
        const { entrada } = await entryFixtures();
        await reserve(entrada.idempotencyKey, new Date());

        const error = await expectSyncCode(
            stockEntriesService.createStockEntry(entrada),
            'ENTRY_IN_PROGRESS',
            true,
        );
        expect(error.statusCode).toBe(409);
    });

    it('ENTRY_IN_PROGRESS: el primer intento truena con un 5xx y el reintento llega a tiempo',
        async () => {
            const { entrada } = await entryFixtures();
            const spy = jest.spyOn(inventoryService, 'recordEntry')
                .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'));

            await expect(stockEntriesService.createStockEntry(entrada))
                .rejects.toThrow('DEADLINE_EXCEEDED');
            spy.mockRestore();

            await expectSyncCode(
                stockEntriesService.createStockEntry(entrada),
                'ENTRY_IN_PROGRESS',
                true,
            );
        });

    it('ENTRY_IN_PROGRESS: dos intentos simultáneos, el que pierde la reserva', async () => {
        const { entrada, product } = await entryFixtures();

        const results = await Promise.allSettled([
            stockEntriesService.createStockEntry(entrada),
            stockEntriesService.createStockEntry(entrada),
        ]);

        const rejected = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        // O el segundo ya ve la entrada aplicada (y la devuelve), o choca con la
        // reserva en curso; nunca un 500 ni un rechazo permanente.
        for (const { reason } of rejected) {
            expect(reason).toMatchObject({ syncCode: 'ENTRY_IN_PROGRESS', retryable: true });
        }
        expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
        const fresh = await productsRepo.getProductById(product.id);
        expect(fresh?.totalStock).toBe(5);
    });

    it('ENTRY_AMBIGUOUS: reserva vieja y ese lote con otra cantidad en la factura', async () => {
        const { entrada } = await entryFixtures();
        await reserve(entrada.idempotencyKey, new Date(Date.now() - 60 * 60 * 1000));
        await stockEntriesService.createStockEntry({
            ...entrada,
            quantity: 3,
            idempotencyKey: unique('otra'),
        });

        const error = await expectSyncCode(
            stockEntriesService.createStockEntry(entrada),
            'ENTRY_AMBIGUOUS',
        );
        expect(error.statusCode).toBe(409);
    });

    it('PRODUCT_NOT_FOUND', async () => {
        const { entrada } = await entryFixtures();

        await expectSyncCode(
            stockEntriesService.createStockEntry({ ...entrada, productId: 'no-existe' }),
            'PRODUCT_NOT_FOUND',
        );
        await expectSyncCode(
            stockEntriesService.createStockEntry({
                ...entrada,
                productId: 'no-existe',
                productUpdate: { salePrice: 12 },
                idempotencyKey: unique('otra'),
            }),
            'PRODUCT_NOT_FOUND',
        );
    });

    it('VALIDATION: factura inexistente o partida inválida', async () => {
        const { entrada } = await entryFixtures();

        await expectSyncCode(
            stockEntriesService.createStockEntry({ ...entrada, invoiceId: 'no-existe' }),
            'VALIDATION',
        );
        await expectSyncCode(
            stockEntriesService.createStockEntry({ ...entrada, quantity: 0 }),
            'VALIDATION',
        );
    });
});

describe('POST /sales/bulk: resultado por índice', () => {
    const user = { uid: 'cajero-a', role: { slug: 'cashier' } } as unknown as AuthUser;
    const item = (key: string) => ({
        items: [{ productId: 'p', quantity: 1 }],
        paymentMethod: 'cash',
        amountReceived: 10,
        cashSessionId: 's',
        // La venta se valida dentro del lote (SPEC 48): la llave debe ser válida.
        idempotencyKey: `llave-${key}-0001`,
    });

    afterEach(() => jest.restoreAllMocks());

    it('cada rechazo trae code y retryable; lo inesperado sale INTERNAL reintentable', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const okSale = { id: 'venta-1' };
        jest.spyOn(salesService, 'createSale')
            .mockResolvedValueOnce(okSale as never)
            .mockRejectedValueOnce(badRequest('Stock insuficiente para X', 'STOCK_INSUFFICIENT'))
            .mockRejectedValueOnce(Object.assign(
                new Error('10 ABORTED: Transaction lock timeout'),
                { code: 10 },
            ))
            .mockRejectedValueOnce(new AppError(502, 'MERCADOPAGO_UNAVAILABLE', 'MP caído'))
            .mockRejectedValueOnce(notFound('Doctor x'));

        const { data } = await new SalesController().bulkCreate(
            { items: ['a', 'b', 'c', 'd', 'e'].map((key) => item(key)) } as never,
            user,
        );

        expect(data).toEqual([
            { ok: true, sale: okSale },
            {
                ok: false,
                code: 'STOCK_INSUFFICIENT',
                error: 'Stock insuficiente para X',
                retryable: false,
            },
            {
                ok: false,
                code: 'INTERNAL',
                error: '10 ABORTED: Transaction lock timeout',
                retryable: true,
            },
            { ok: false, code: 'INTERNAL', error: 'MP caído', retryable: true },
            { ok: false, code: 'VALIDATION', error: 'Doctor x no encontrado', retryable: false },
        ]);
    });

    it('un error inesperado no tumba el lote: las demás siguen y queda en el log', async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        jest.spyOn(salesService, 'createSale')
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ id: 'venta-2' } as never);

        const { data } = await new SalesController().bulkCreate(
            { items: [item('a'), item('b')] } as never,
            user,
        );

        expect(data[0]).toMatchObject({ ok: false, code: 'INTERNAL', retryable: true });
        expect(data[1]).toMatchObject({ ok: true });
        expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    });
});
