import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import { Sale } from '../src/types';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 50 — el reparto FEFO se decide dentro de la transacción, con los lotes
 * leídos por consulta. El plan de fuera solo valida y da el mensaje en línea:
 * si otra caja vació el lote planeado, la venta toma del siguiente en vez de
 * rechazarse con stock en otro lote.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const CASHIER = 'cajero-50';

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
});

const createProduct = (overrides: Record<string, unknown> = {}) =>
    productsService.createProduct({
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

const addBatch = (productId: string, quantity: number, expiry: string, costPrice: number) =>
    batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp(expiry),
        quantity,
        costPrice,
    });

const openSession = () => cashSessionsRepo.createCashSession({
    openedBy: CASHIER,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const batchQty = async (batchId: string) =>
    (await db().collection('batches').doc(batchId).get()).data()?.quantity as number;

/**
 * Detiene la lectura previa de lotes hasta que `n` ventas la hayan hecho: así
 * todas planean sobre el mismo estado (el lote L1 completo) antes de que la
 * primera confirme, que es la carrera entre dos cajas.
 */
const holdPreloadUntil = (n: number) => {
    const original = batchesRepo.listBatchesByProduct;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    jest.spyOn(batchesRepo, 'listBatchesByProduct').mockImplementation(async (...args) => {
        const result = await original(...args);
        arrived += 1;
        if (arrived >= n) {
            release();
        }
        await gate;
        return result;
    });
};

const sell = (productId: string, sessionId: string, quantity: number, extra = {}) =>
    salesService.createSale({
        items: [{ productId, quantity, unitPrice: 20 }],
        paymentMethod: 'cash',
        amountReceived: 20 * quantity,
        cashSessionId: sessionId,
        cashierId: CASHIER,
        ...extra,
    });

describe('SPEC 50 — FEFO dentro de la transacción de venta', () => {
    it('L1 = 3 y L2 = 10: dos ventas concurrentes de 3 se registran, una por lote', async () => {
        const product = await createProduct({ controlledGroup: 'IV' });
        const l1 = await addBatch(product.id, 3, '2027-01-01', 10);
        const l2 = await addBatch(product.id, 10, '2028-01-01', 12);
        await productsRepo.updateProduct(product.id, { totalStock: 13 });
        const session = await openSession();
        const prescription = { doctorName: 'Dra. Ruiz', doctorLicense: '1234567' };

        holdPreloadUntil(2);
        const [a, b] = await Promise.all([
            sell(product.id, session.id, 3, { prescription }),
            sell(product.id, session.id, 3, { prescription }),
        ]);

        const lots = [a, b].map((sale) => productItem(sale).batchAllocations);
        expect(lots).toEqual(expect.arrayContaining([
            [{ batchId: l1.id, quantity: 3 }],
            [{ batchId: l2.id, quantity: 3 }],
        ]));
        expect(await batchQty(l1.id)).toBe(0);
        expect(await batchQty(l2.id)).toBe(7);
        expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(7);

        // Costo y libro de controlados salen del reparto transaccional.
        const fromL2 = [a, b].find((sale) =>
            productItem(sale).batchAllocations[0].batchId === l2.id) as Sale;
        expect(productItem(fromL2).costAmount).toBe(36);
        expect(fromL2.costTotal).toBe(36);
        const stored = (await db().collection('sales').doc(fromL2.id).get()).data()!;
        expect(stored.items[0].batchAllocations).toEqual([{ batchId: l2.id, quantity: 3 }]);
        const ledger = await db().collection('controlledSalesLedger')
            .where('saleId', '==', fromL2.id).get();
        expect(ledger.docs.map((doc) => doc.data().lotNumbers)).toEqual([[l2.lotNumber]]);
        const movements = await db().collection('stockMovements')
            .where('referenceId', '==', fromL2.id).get();
        expect(movements.docs.map((doc) => doc.data().batchId)).toEqual([l2.id]);
    });

    it('dos ventas concurrentes que exceden el total: solo una falla por stock', async () => {
        const product = await createProduct();
        const l1 = await addBatch(product.id, 3, '2027-01-01', 10);
        const l2 = await addBatch(product.id, 2, '2028-01-01', 10);
        await productsRepo.updateProduct(product.id, { totalStock: 5 });
        const session = await openSession();

        holdPreloadUntil(2);
        const results = await Promise.allSettled([
            sell(product.id, session.id, 3),
            sell(product.id, session.id, 3),
        ]);

        const rejected = results.filter((result) => result.status === 'rejected');
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const reason = (rejected[0] as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(AppError);
        expect(reason).toMatchObject({
            syncCode: 'STOCK_INSUFFICIENT',
            message: expect.stringContaining('Stock insuficiente para'),
        });
        expect((await batchQty(l1.id)) + (await batchQty(l2.id))).toBe(2);
        const sales = await db().collection('sales')
            .where('cashSessionId', '==', session.id).get();
        expect(sales.size).toBe(1);
    });

    it('lote que caduca entre el plan y la transacción: decide el reparto de adentro', async () => {
        const product = await createProduct();
        const l1 = await addBatch(product.id, 5, '2027-01-01', 10);
        const l2 = await addBatch(product.id, 10, '2028-01-01', 10);
        await productsRepo.updateProduct(product.id, { totalStock: 15 });
        const session = await openSession();

        const original = batchesRepo.listBatchesByProduct;
        jest.spyOn(batchesRepo, 'listBatchesByProduct').mockImplementation(async (...args) => {
            const result = await original(...args);
            // El plan ya eligió L1; para cuando corre la transacción está vencido.
            await db().collection('batches').doc(l1.id)
                .update({ expiryDate: toTimestamp('2020-01-01') });
            return result;
        });

        const sale = await sell(product.id, session.id, 3);
        expect(productItem(sale).batchAllocations).toEqual([{ batchId: l2.id, quantity: 3 }]);
        expect(await batchQty(l1.id)).toBe(5);
        expect(await batchQty(l2.id)).toBe(7);
    });

    it('mismo producto en pieza y caja: se reparte sobre el total de piezas', async () => {
        const product = await createProduct({ boxQuantity: 10, boxPrice: 180 });
        const l1 = await addBatch(product.id, 15, '2027-01-01', 10);
        const l2 = await addBatch(product.id, 30, '2028-01-01', 11);
        await productsRepo.updateProduct(product.id, { totalStock: 45 });
        const session = await openSession();

        const sale = await salesService.createSale({
            items: [
                { productId: product.id, quantity: 1, saleUnit: 'box', unitPrice: 180 },
                { productId: product.id, quantity: 8, unitPrice: 20 },
            ],
            paymentMethod: 'cash',
            amountReceived: 340,
            cashSessionId: session.id,
            cashierId: CASHIER,
        });

        expect(productItem(sale, 0).batchAllocations).toEqual([{ batchId: l1.id, quantity: 10 }]);
        expect(productItem(sale, 1).batchAllocations).toEqual([
            { batchId: l1.id, quantity: 5 },
            { batchId: l2.id, quantity: 3 },
        ]);
        expect(await batchQty(l1.id)).toBe(0);
        expect(await batchQty(l2.id)).toBe(27);
        expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(27);
    });

    it('la transacción lee los lotes por consulta, uno por producto distinto', async () => {
        const product = await createProduct({ boxQuantity: 10, boxPrice: 180 });
        await addBatch(product.id, 30, '2028-01-01', 11);
        await productsRepo.updateProduct(product.id, { totalStock: 30 });
        const session = await openSession();

        const query = jest.spyOn(batchesRepo, 'availableBatchesQuery');
        await salesService.createSale({
            items: [
                { productId: product.id, quantity: 1, saleUnit: 'box', unitPrice: 180 },
                { productId: product.id, quantity: 2, unitPrice: 20 },
            ],
            paymentMethod: 'cash',
            amountReceived: 220,
            cashSessionId: session.id,
            cashierId: CASHIER,
        });

        // Una para el plan previo (dentro de listBatchesByProduct) y una en la
        // transacción: sin doble lectura por la segunda partida.
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.every(([id]) => id === product.id)).toBe(true);
    });
});
