import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { SalesController } from '../src/modules/sales/sales.controller';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import { BULK_SALES_MAX_ITEMS, bulkCreateSalesSchema } from '../src/schemas';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as productsService from '../src/services/products.service';
import * as promotionsService from '../src/services/promotions.service';
import * as salesService from '../src/services/sales.service';
import { AuthUser } from '../src/types';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 48 — lote de sincronización tolerante: la idempotencia se revisa antes que
 * el catálogo y el stock, cada venta del lote se valida por separado y el lote
 * responde dentro de su presupuesto aunque no haya procesado todo.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const key = () => unique('llave');
const CASHIER = 'cajero-48';
const ADMIN = { userId: 'admin-48', roleSlug: 'admin' };

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
});

const createProduct = async (stock: number, overrides: Record<string, unknown> = {}) => {
    const product = await productsService.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 20,
        minStock: 1,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        ...overrides,
    } as Parameters<typeof productsService.createProduct>[0]);
    const batch = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-01-01'),
        quantity: stock,
        costPrice: 8,
    });
    await productsRepo.updateProduct(product.id, { totalStock: stock });
    return { product, batch };
};

const openSession = (openedBy = CASHIER) => cashSessionsRepo.createCashSession({
    openedBy,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const batchQty = async (batchId: string) =>
    (await db().collection('batches').doc(batchId).get()).data()?.quantity as number;

const salesOfSession = async (sessionId: string) =>
    (await db().collection('sales').where('cashSessionId', '==', sessionId).get()).size;

/**
 * Simula una llave escrita antes de SPEC 48: solo trae la huella resuelta. Las de
 * entonces se guardaban como `<cajero>:<key>` (SPEC 54 las guarda por turno), así
 * que se mueve el documento a ese id.
 */
const makeLegacy = async (sessionId: string, cashierId: string, idempotencyKey: string) => {
    const keys = db().collection('saleIdempotencyKeys');
    const current = keys.doc(`${sessionId}:${idempotencyKey}`);
    const data = (await current.get()).data()!;
    expect(data.payloadFingerprint).toEqual(expect.any(String));
    delete data.payloadFingerprint;
    await keys.doc(`${cashierId}:${idempotencyKey}`).set(data);
    await current.delete();
};

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
    const error = await promise.then(
        () => { throw new Error('Se esperaba un rechazo'); },
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
};

describe('SPEC 48 — idempotencia antes de catálogo, stock y tope', () => {
    it('repetir la venta que agotó el stock con la misma llave devuelve esa venta', async () => {
        const { product, batch } = await createProduct(2);
        const session = await openSession();
        const input = {
            idempotencyKey: key(),
            items: [{ productId: product.id, quantity: 2, unitPrice: 20 }],
            paymentMethod: 'cash' as const,
            amountReceived: 40,
            cashSessionId: session.id,
            cashierId: CASHIER,
            roleSlug: 'cashier',
        };
        const first = await salesService.createSale(input);
        expect(await batchQty(batch.id)).toBe(0);

        // El reintento no lee lotes ni catálogo: solo la llave y la venta.
        const batchReads = jest.spyOn(batchesRepo, 'listBatchesByProduct');
        const productReads = jest.spyOn(productsRepo, 'getProductsByIds');
        const replay = await salesService.createSale(input);

        expect(replay.id).toBe(first.id);
        expect(replay.folio).toBe(first.folio);
        expect(batchReads).not.toHaveBeenCalled();
        expect(productReads).not.toHaveBeenCalled();
        expect(await batchQty(batch.id)).toBe(0);
        expect(await salesOfSession(session.id)).toBe(1);
    });

    it('repetir después de desactivar el producto devuelve la venta', async () => {
        const { product } = await createProduct(5);
        const session = await openSession();
        const input = {
            idempotencyKey: key(),
            items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
            paymentMethod: 'cash' as const,
            amountReceived: 20,
            cashSessionId: session.id,
            cashierId: CASHIER,
            offline: true,
        };
        const first = await salesService.createSale(input);
        await productsRepo.updateProduct(product.id, { isActive: false });

        const replay = await salesService.createSale(input);
        expect(replay.id).toBe(first.id);
    });

    it('repetir con el turno ya cerrado devuelve la venta', async () => {
        const { product } = await createProduct(5);
        const session = await openSession();
        const input = {
            idempotencyKey: key(),
            items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
            paymentMethod: 'cash' as const,
            amountReceived: 20,
            cashSessionId: session.id,
            cashierId: CASHIER,
        };
        const first = await salesService.createSale(input);
        await db().collection('cashSessions').doc(session.id)
            .update({ closedAt: toTimestamp('2026-11-06T20:00:00Z') });

        expect((await salesService.createSale(input)).id).toBe(first.id);
    });

    it('repetir después de perder el rol que autorizó el descuento devuelve la venta', async () => {
        const { product } = await createProduct(5);
        const session = await openSession();
        const input = {
            idempotencyKey: key(),
            // 50 % de descuento: solo un administrador puede darlo.
            items: [{ productId: product.id, quantity: 1, unitPrice: 20, discountAmount: 10 }],
            paymentMethod: 'cash' as const,
            amountReceived: 10,
            cashSessionId: session.id,
            cashierId: CASHIER,
        };
        const first = await salesService.createSale({ ...input, roleSlug: 'admin' });

        const replay = await salesService.createSale({ ...input, roleSlug: 'cashier' });
        expect(replay.id).toBe(first.id);
    });

    it('misma llave con otro carrito: CONFLICT antes de tocar el stock', async () => {
        const { product, batch } = await createProduct(2);
        const session = await openSession();
        const idempotencyKey = key();
        const base = {
            idempotencyKey,
            paymentMethod: 'cash' as const,
            cashSessionId: session.id,
            cashierId: CASHIER,
        };
        await salesService.createSale({
            ...base,
            items: [{ productId: product.id, quantity: 2, unitPrice: 20 }],
            amountReceived: 40,
        });

        // Sin stock: antes respondía "Stock insuficiente"; ahora gana la llave.
        const error = await rejection(salesService.createSale({
            ...base,
            items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
            amountReceived: 20,
        }));
        expect(error).toMatchObject({ code: 'CONFLICT', syncCode: 'IDEMPOTENCY_CONFLICT' });
        expect(await batchQty(batch.id)).toBe(0);
        expect(await salesOfSession(session.id)).toBe(1);
    });

    it('un cambio de precio no vuelve conflicto un reintento sin unitPrice', async () => {
        const { product } = await createProduct(5);
        const session = await openSession();
        const input = {
            idempotencyKey: key(),
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash' as const,
            amountReceived: 50,
            cashSessionId: session.id,
            cashierId: CASHIER,
        };
        const first = await salesService.createSale(input);
        await productsRepo.updateProduct(product.id, { salePrice: 25 });

        expect((await salesService.createSale(input)).id).toBe(first.id);
    });

    it('la llave guarda la huella del payload y la resuelta de siempre', async () => {
        const { product } = await createProduct(5);
        const session = await openSession();
        const idempotencyKey = key();
        await salesService.createSale({
            idempotencyKey,
            items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
            paymentMethod: 'cash',
            amountReceived: 20,
            cashSessionId: session.id,
            cashierId: CASHIER,
        });
        const stored = (await db().collection('saleIdempotencyKeys')
            .doc(`${session.id}:${idempotencyKey}`).get()).data()!;
        expect(stored.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(stored.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(stored.payloadFingerprint).not.toBe(stored.requestFingerprint);
    });

    describe('llaves anteriores a SPEC 48 (solo huella resuelta)', () => {
        it('pieza con descuento de partida y de venta: devuelve la venta sin stock', async () => {
            const { product, batch } = await createProduct(3);
            const session = await openSession();
            const input = {
                idempotencyKey: key(),
                items: [{ productId: product.id, quantity: 3, unitPrice: 20, discountAmount: 2.5 }],
                saleDiscountAmount: 1.25,
                paymentMethod: 'cash' as const,
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: CASHIER,
            };
            const first = await salesService.createSale(input);
            await makeLegacy(input.cashSessionId, CASHIER, input.idempotencyKey);
            expect(await batchQty(batch.id)).toBe(0);

            const batchReads = jest.spyOn(batchesRepo, 'listBatchesByProduct');
            expect((await salesService.createSale(input)).id).toBe(first.id);
            expect(batchReads).not.toHaveBeenCalled();
        });

        it('venta por caja con precio de catálogo: devuelve la venta sin stock', async () => {
            const { product } = await createProduct(10, { boxQuantity: 5, boxPrice: 90 });
            const session = await openSession();
            const input = {
                idempotencyKey: key(),
                items: [{ productId: product.id, quantity: 2, saleUnit: 'box' as const }],
                paymentMethod: 'cash' as const,
                amountReceived: 180,
                cashSessionId: session.id,
                cashierId: CASHIER,
            };
            const first = await salesService.createSale(input);
            await makeLegacy(input.cashSessionId, CASHIER, input.idempotencyKey);

            expect((await salesService.createSale(input)).id).toBe(first.id);
        });

        it('promoción y servicio: devuelve la venta sin stock', async () => {
            const { product } = await createProduct(2, { salePrice: 35 });
            const promotion = await promotionsService.createPromotion({
                name: unique('2x$60'),
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
                productIds: [product.id],
            }, ADMIN);
            const service = await pharmacyServicesService.createPharmacyService({
                code: unique('SRV'),
                name: unique('Consulta'),
                serviceType: 'consultation',
                price: 250,
                taxMode: 'exempt',
                hasIeps: false,
                commissionRate: 0,
                requiresPerformer: false,
            } as Parameters<typeof pharmacyServicesService.createPharmacyService>[0], ADMIN);
            const session = await openSession();
            const input = {
                idempotencyKey: key(),
                items: [
                    {
                        productId: product.id,
                        quantity: 2,
                        unitPrice: 35,
                        discountAmount: 10,
                        promotionId: promotion.id,
                    },
                    { kind: 'service' as const, serviceId: service.id, quantity: 1 },
                ],
                paymentMethod: 'cash' as const,
                amountReceived: 310,
                cashSessionId: session.id,
                cashierId: CASHIER,
            };
            const first = await salesService.createSale(input);
            expect(first.promotionIds).toEqual([promotion.id]);
            await makeLegacy(input.cashSessionId, CASHIER, input.idempotencyKey);

            expect((await salesService.createSale(input)).id).toBe(first.id);
        });

        it('otro carrito con una llave vieja sigue respondiendo CONFLICT', async () => {
            const { product } = await createProduct(10);
            const session = await openSession();
            const idempotencyKey = key();
            const base = {
                idempotencyKey,
                paymentMethod: 'cash' as const,
                cashSessionId: session.id,
                cashierId: CASHIER,
            };
            await salesService.createSale({
                ...base,
                items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
                amountReceived: 20,
            });
            await makeLegacy(session.id, CASHIER, idempotencyKey);

            const error = await rejection(salesService.createSale({
                ...base,
                items: [{ productId: product.id, quantity: 2, unitPrice: 20 }],
                amountReceived: 40,
            }));
            expect(error.syncCode).toBe('IDEMPOTENCY_CONFLICT');
            expect(await salesOfSession(session.id)).toBe(1);
        });
    });

    it('las lecturas de lotes de una venta van en paralelo', async () => {
        const products = [];
        for (let i = 0; i < 4; i++) {
            products.push((await createProduct(5)).product);
        }
        const session = await openSession();

        const original = batchesRepo.listBatchesByProduct;
        let inFlight = 0;
        let maxInFlight = 0;
        jest.spyOn(batchesRepo, 'listBatchesByProduct').mockImplementation(async (...args) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                return await original(...args);
            } finally {
                inFlight -= 1;
            }
        });

        await salesService.createSale({
            items: products.map((product) => ({ productId: product.id, quantity: 1 })),
            paymentMethod: 'cash',
            amountReceived: 80,
            cashSessionId: session.id,
            cashierId: CASHIER,
        });
        expect(maxInFlight).toBe(4);
    });
});

describe('SPEC 48 — POST /sales/bulk tolerante', () => {
    const user = { uid: CASHIER, role: { slug: 'cashier' } } as unknown as AuthUser;

    const sale = (
        productId: string,
        sessionId: string,
        overrides: Record<string, unknown> = {},
    ) => ({
        idempotencyKey: key(),
        items: [{ productId, quantity: 1, unitPrice: 20 }],
        paymentMethod: 'cash',
        amountReceived: 20,
        cashSessionId: sessionId,
        ...overrides,
    });

    it('el lote acepta hasta 50 ventas sin validarlas y rechaza 51', () => {
        const pipe = new ZodValidationPipe(bulkCreateSalesSchema);
        expect(BULK_SALES_MAX_ITEMS).toBe(50);
        expect(pipe.transform({ items: Array.from({ length: 50 }, () => ({})) }).items)
            .toHaveLength(50);
        let error: unknown;
        try {
            pipe.transform({ items: Array.from({ length: 51 }, () => ({})) });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ statusCode: 400, syncCode: 'VALIDATION' });
        expect(() => pipe.transform({ items: [] })).toThrow(AppError);
    });

    it('3 ventas con la del medio inválida: registra 1 y 3, la 2 es VALIDATION', async () => {
        const { product, batch } = await createProduct(10);
        const session = await openSession();
        const items = [
            sale(product.id, session.id),
            // Cédula de 5 dígitos: antes tumbaba el lote entero con 400.
            sale(product.id, session.id, {
                prescription: { doctorName: 'Dr. X', doctorLicense: '12345' },
            }),
            sale(product.id, session.id),
        ];

        const { data } = await new SalesController().bulkCreate({ items }, user);

        expect(data[0]).toMatchObject({ ok: true });
        expect(data[1]).toEqual({
            ok: false,
            code: 'VALIDATION',
            error: expect.stringContaining('La cédula profesional debe tener 7 u 8 dígitos'),
            retryable: false,
        });
        expect(data[2]).toMatchObject({ ok: true });
        expect(await salesOfSession(session.id)).toBe(2);
        expect(await batchQty(batch.id)).toBe(8);
    });

    it('un lote con todas las ventas inválidas responde todas en VALIDATION', async () => {
        const session = await openSession();
        const { data } = await new SalesController().bulkCreate({
            items: [
                { items: [], paymentMethod: 'cash', cashSessionId: session.id },
                'no es una venta',
                sale('p', session.id, { paymentMethod: 'cheque' }),
            ],
        }, user);

        expect(data).toHaveLength(3);
        for (const result of data) {
            expect(result).toMatchObject({ ok: false, code: 'VALIDATION', retryable: false });
        }
        // Los mensajes por omisión de Zod llegan en español al cajero.
        expect(data[1]).toMatchObject({ error: expect.stringContaining('se esperaba object') });
        expect(data[2]).toMatchObject({
            error: expect.stringContaining('paymentMethod: Valor inválido; se esperaba'),
        });
        expect(await salesOfSession(session.id)).toBe(0);
    });

    it('con el presupuesto en 0 ms todas responden DEFERRED y no se escribe nada', async () => {
        const { product, batch } = await createProduct(10);
        const session = await openSession();
        const items = [sale(product.id, session.id), sale(product.id, session.id)];
        const create = jest.spyOn(salesService, 'createSale');

        const controller = new SalesController();
        controller.bulkBudgetMs = 0;
        const { data } = await controller.bulkCreate({ items }, user);

        expect(data).toEqual([
            { ok: false, code: 'DEFERRED', error: expect.any(String), retryable: true },
            { ok: false, code: 'DEFERRED', error: expect.any(String), retryable: true },
        ]);
        expect(create).not.toHaveBeenCalled();
        expect(await salesOfSession(session.id)).toBe(0);
        expect(await batchQty(batch.id)).toBe(10);
        const keys = await db().collection('saleIdempotencyKeys')
            .where('cashierId', '==', CASHIER).get();
        const keyIds = new Set(keys.docs.map((doc) => doc.id));
        for (const item of items) {
            expect(keyIds.has(`${session.id}:${item.idempotencyKey}`)).toBe(false);
        }
    });

    it('presupuesto agotado a media corrida: lo procesado queda, el resto se difiere', async () => {
        const { product } = await createProduct(10);
        const session = await openSession();
        const items = [
            sale(product.id, session.id),
            sale(product.id, session.id),
            sale(product.id, session.id),
        ];
        const controller = new SalesController();
        const realNow = Date.now;
        const original = salesService.createSale;
        jest.spyOn(salesService, 'createSale').mockImplementation(async (input) => {
            const result = await original(input);
            // La primera venta "tarda" más que todo el presupuesto.
            const shifted = realNow() + controller.bulkBudgetMs + 1;
            jest.spyOn(Date, 'now').mockImplementation(() => shifted);
            return result;
        });

        const { data } = await controller.bulkCreate({ items }, user);

        expect(data.map((result) => (result.ok ? 'ok' : result.code)))
            .toEqual(['ok', 'DEFERRED', 'DEFERRED']);
        expect(await salesOfSession(session.id)).toBe(1);
    });

    it('reintentar el lote completo devuelve las ventas ya registradas', async () => {
        const { product, batch } = await createProduct(2);
        const session = await openSession();
        const items = [sale(product.id, session.id), sale(product.id, session.id)];
        const controller = new SalesController();

        const first = await controller.bulkCreate({ items }, user);
        const retry = await controller.bulkCreate({ items }, user);

        expect(retry.data.map((result) => result.ok)).toEqual([true, true]);
        expect(retry.data.map((result) => (result.ok ? result.sale.id : null)))
            .toEqual(first.data.map((result) => (result.ok ? result.sale.id : null)));
        expect(await batchQty(batch.id)).toBe(0);
        expect(await salesOfSession(session.id)).toBe(2);
    });
});
