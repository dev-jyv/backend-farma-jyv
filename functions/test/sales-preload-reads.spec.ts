import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as salesService from '../src/services/sales.service';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const makeCategory = () => categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });

const createProduct = async (categoryId: string) =>
    productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: false,
        suppliers: [],
    });

const addBatch = async (productId: string, quantity: number, expiryDate: string) =>
    batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp(expiryDate),
        quantity,
    });

const openSession = async () =>
    cashSessionsRepo.createCashSession({
        openedBy: 'test-cashier',
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });

describe('sales.service - lecturas previas de createSale', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('onlyAvailable devuelve solo lotes con existencia, por caducidad', async () => {
        const category = await makeCategory();
        const product = await createProduct(category.id);
        await addBatch(product.id, 0, '2026-12-01');
        const late = await addBatch(product.id, 3, '2028-01-01');
        const early = await addBatch(product.id, 5, '2027-01-01');

        const available = await batchesRepo.listBatchesByProduct(product.id, {
            onlyAvailable: true,
        });
        expect(available.map((b) => b.id)).toEqual([early.id, late.id]);

        const all = await batchesRepo.listBatchesByProduct(product.id);
        expect(all).toHaveLength(3);
    });

    it('con 1 lote vigente y 200 agotados la fase previa lee solo el vigente', async () => {
        const category = await makeCategory();
        const product = await createProduct(category.id);
        const session = await openSession();
        await Promise.all(
            Array.from({ length: 200 }, (_, i) =>
                addBatch(product.id, 0, `2026-0${(i % 9) + 1}-15`)),
        );
        const live = await addBatch(product.id, 10, '2027-06-01');
        await productsRepo.updateProduct(product.id, { totalStock: 10 });

        const spy = jest.spyOn(batchesRepo, 'listBatchesByProduct');
        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 4 }],
            paymentMethod: 'cash',
            amountReceived: 40,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(product.id, { onlyAvailable: true });
        const returned = await spy.mock.results[0].value;
        expect(returned.map((b: { id: string }) => b.id)).toEqual([live.id]);
        expect(sale.total).toBe(40);
    });

    it('una venta de 20 partidas lee los productos en una sola operación', async () => {
        const category = await makeCategory();
        const session = await openSession();
        const products = await Promise.all(
            Array.from({ length: 20 }, () => createProduct(category.id)),
        );
        await Promise.all(products.map((p) => addBatch(p.id, 5, '2027-06-01')));
        await Promise.all(
            products.map((p) => productsRepo.updateProduct(p.id, { totalStock: 5 })),
        );

        const bulk = jest.spyOn(productsRepo, 'getProductsByIds');
        const single = jest.spyOn(productsRepo, 'getProductById');
        const batchRead = jest.spyOn(batchesRepo, 'listBatchesByProduct');
        const getAll = jest.spyOn(db(), 'getAll');

        await salesService.createSale({
            items: products.map((p) => ({ productId: p.id, quantity: 1 })),
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(bulk).toHaveBeenCalledTimes(1);
        expect(single).not.toHaveBeenCalled();
        // Un getAll con las 20 referencias en lugar de 20 lecturas sueltas.
        const productCalls = getAll.mock.calls.filter((call) => call.length === 20);
        expect(productCalls).toHaveLength(1);
        // Una lectura de lotes por producto, ninguna sobre el historial agotado.
        expect(batchRead).toHaveBeenCalledTimes(20);
    });

    it('lote agotado entre la lectura previa y la transacción: rechaza sin negativos', async () => {
        const category = await makeCategory();
        const product = await createProduct(category.id);
        const session = await openSession();
        const batch = await addBatch(product.id, 5, '2027-06-01');
        await productsRepo.updateProduct(product.id, { totalStock: 5 });

        const original = batchesRepo.listBatchesByProduct;
        jest.spyOn(batchesRepo, 'listBatchesByProduct').mockImplementation(async (...args) => {
            const result = await original(...args);
            // La "otra venta" concurrente vacía el lote después de la lectura previa.
            await db().collection('batches').doc(batch.id).update({ quantity: 0 });
            await db().collection('products').doc(product.id)
                .update({ totalStock: 0 });
            return result;
        });

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 4 }],
                paymentMethod: 'cash',
                amountReceived: 40,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({ message: expect.stringContaining('Stock insuficiente') });

        const after = await db().collection('batches').doc(batch.id).get();
        expect(after.data()?.quantity).toBe(0);
        const prod = await productsRepo.getProductById(product.id);
        expect(prod?.totalStock).toBe(0);
    });

    it('un producto sin lotes con existencia sigue dando stock insuficiente', async () => {
        const category = await makeCategory();
        const product = await createProduct(category.id);
        const session = await openSession();
        await addBatch(product.id, 0, '2027-06-01');

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 10,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({ message: expect.stringContaining('Stock insuficiente') });
    });
});
