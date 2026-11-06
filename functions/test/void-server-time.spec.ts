import { Timestamp } from 'firebase-admin/firestore';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 56, punto 6 — `products.updatedAt` y `batches.updatedAt` son el cursor del
 * pull de las cajas: una anulación offline con su `voidedAt` en el pasado no los
 * puede escribir hacia atrás. La hora reportada solo va a la venta, a los
 * movimientos y al libro.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const CASHIER = 'cajero-56';
const HOUR_MS = 60 * 60 * 1000;

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

const createStockedProduct = async () => {
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
    } as Parameters<typeof productsService.createProduct>[0]);
    const batch = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-01-01'),
        quantity: 10,
        costPrice: 8,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 10 });
    return { product, batch };
};

const openSessionAt = async (openedAt: Date) => {
    const ref = await db().collection('cashSessions').add({
        openedBy: CASHIER,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
        openedAt: Timestamp.fromDate(openedAt),
    });
    return ref.id;
};

describe('SPEC 56 — la anulación escribe updatedAt con la hora del servidor', () => {
    it('anular con voidedAt en el pasado deja updatedAt en la hora del servidor', async () => {
        const { product, batch } = await createStockedProduct();
        const openedAt = new Date(Date.now() - 6 * HOUR_MS);
        const sessionId = await openSessionAt(openedAt);
        const soldAt = new Date(Date.now() - 5 * HOUR_MS).toISOString();
        const sale = await salesService.createSale({
            idempotencyKey: unique('llave'),
            items: [{ productId: product.id, quantity: 2, unitPrice: 20 }],
            paymentMethod: 'cash',
            amountReceived: 40,
            cashSessionId: sessionId,
            cashierId: CASHIER,
            roleSlug: 'cashier',
            offline: true,
            soldAt,
        });

        const voidedAt = new Date(Date.now() - 4 * HOUR_MS).toISOString();
        const before = Date.now();
        const voided = await salesService.voidSale(sale.id, CASHIER, 'cashier', { voidedAt });

        // La venta conserva la hora del hecho.
        expect(voided.voidedAt?.toDate().toISOString()).toBe(voidedAt);

        const productDoc = (await db().collection('products').doc(product.id).get()).data()!;
        const batchDoc = (await db().collection('batches').doc(batch.id).get()).data()!;
        expect((productDoc.updatedAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(before);
        expect((batchDoc.updatedAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(before);
        expect(batchDoc.quantity).toBe(10);

        // Los movimientos de la anulación llevan el hecho y el registro.
        const movements = await db().collection('stockMovements')
            .where('referenceId', '==', sale.id).get();
        const reverse = movements.docs.map((doc) => doc.data())
            .find((movement) => (movement.quantity as number) < 0)!;
        expect((reverse.createdAt as Timestamp).toDate().toISOString()).toBe(voidedAt);
        expect((reverse.recordedAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(before);
    });

    it('una venta con soldAt viejo escribe updatedAt con la hora del servidor', async () => {
        const { product, batch } = await createStockedProduct();
        const sessionId = await openSessionAt(new Date(Date.now() - 6 * HOUR_MS));
        const before = Date.now();
        await salesService.createSale({
            idempotencyKey: unique('llave'),
            items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
            paymentMethod: 'cash',
            amountReceived: 20,
            cashSessionId: sessionId,
            cashierId: CASHIER,
            roleSlug: 'cashier',
            offline: true,
            soldAt: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
        });

        const productDoc = (await db().collection('products').doc(product.id).get()).data()!;
        const batchDoc = (await db().collection('batches').doc(batch.id).get()).data()!;
        expect((productDoc.updatedAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(before);
        expect((batchDoc.updatedAt as Timestamp).toMillis()).toBeGreaterThanOrEqual(before);
    });
});
