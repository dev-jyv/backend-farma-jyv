import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../src/utils/firestore';
import * as salesRepo from '../src/repositories/sales.repository';
import * as productsService from '../src/services/products.service';

/**
 * GET /products/:id/sales-history pedía las ventas del producto con `array-contains`
 * y `createdAt` descendente, un índice que no existe en producción y que el
 * emulador no exige: respondía 500. Se lee ascendente con el índice declarado y se
 * invierte en memoria. Estas pruebas fijan que el orden (más reciente primero) y el
 * filtro no cambian.
 */
const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const seedSale = async (productId: string, minutesAgo: number, quantity: number) => {
    const ref = await db().collection('sales').add({
        folio: unique('V'),
        productIds: [productId],
        items: [{
            productId,
            productName: 'Producto de prueba',
            quantity,
            unitPrice: 10,
            subtotal: 10 * quantity,
        }],
        subtotal: 10 * quantity,
        discountTotal: 0,
        total: 10 * quantity,
        paymentMethod: 'cash',
        voidedAt: null,
        createdAt: Timestamp.fromMillis(Date.now() - minutesAgo * 60 * 1000),
    });
    return ref.id;
};

describe('listSales por producto', () => {
    it('devuelve primero la venta más reciente y solo las del producto', async () => {
        const productId = unique('prod');
        const oldest = await seedSale(productId, 90, 1);
        const newest = await seedSale(productId, 5, 3);
        const middle = await seedSale(productId, 45, 2);
        await seedSale(unique('otro'), 10, 9);

        const { items } = await salesRepo.listSales({ productId });

        expect(items.map((sale) => sale.id)).toEqual([newest, middle, oldest]);
    });

    it('con maxDocs sigue recortando a las más recientes', async () => {
        const productId = unique('prod');
        await seedSale(productId, 90, 1);
        const newest = await seedSale(productId, 5, 3);
        const middle = await seedSale(productId, 45, 2);

        const { items } = await salesRepo.listSales({ productId, maxDocs: 2 });

        expect(items.map((sale) => sale.id)).toEqual([newest, middle]);
    });
});

describe('productsService.getProductSalesHistory', () => {
    it('lista el historial del producto con la venta más reciente primero', async () => {
        const productRef = await db().collection('products').add({
            name: unique('Producto'),
            sku: unique('SKU'),
            isActive: true,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });
        await seedSale(productRef.id, 60, 1);
        await seedSale(productRef.id, 10, 4);

        const history = await productsService.getProductSalesHistory(productRef.id, {});

        expect(history.items.map((item) => item.quantity)).toEqual([4, 1]);
        expect(history.meta.total).toBe(2);
    });
});
