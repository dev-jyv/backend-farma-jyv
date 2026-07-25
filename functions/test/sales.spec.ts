import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as salesService from '../src/services/sales.service';
import { toTimestamp } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const createProductFixture = async (salePrice = 10) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice,
        minStock: 1,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
};

describe('sales.service - createSale (FEFO)', () => {
    it('asigna stock del lote que caduca primero y descuenta cantidades', async () => {
        const product = await createProductFixture(10);

        const earlyBatch = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-EARLY',
            expiryDate: toTimestamp('2027-01-01'),
            quantity: 5,
        });
        const lateBatch = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-LATE',
            expiryDate: toTimestamp('2027-06-01'),
            quantity: 10,
        });

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 7 }],
            paymentMethod: 'cash',
            cashierId: 'test-cashier',
        });

        expect(sale.total).toBe(70);
        expect(sale.items[0].batchAllocations).toEqual(
            expect.arrayContaining([
                { batchId: earlyBatch.id, quantity: 5 },
                { batchId: lateBatch.id, quantity: 2 },
            ]),
        );

        const updatedEarly = await batchesRepo.getBatchById(earlyBatch.id);
        const updatedLate = await batchesRepo.getBatchById(lateBatch.id);
        expect(updatedEarly!.quantity).toBe(0);
        expect(updatedLate!.quantity).toBe(8);

        const movements = await movementsRepo.listStockMovements({ productId: product.id });
        const saleMovements = movements.filter((m) => m.referenceId === sale.id);
        expect(saleMovements).toHaveLength(2);
        expect(saleMovements.every((m) => m.type === 'sale_adjustment')).toBe(true);
    });

    it('rechaza la venta y no modifica lotes si el stock es insuficiente', async () => {
        const product = await createProductFixture(10);

        const batch = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-CORTO',
            expiryDate: toTimestamp('2027-01-01'),
            quantity: 3,
        });

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 10 }],
                paymentMethod: 'cash',
                cashierId: 'test-cashier',
            }),
        ).rejects.toThrow();

        const unchanged = await batchesRepo.getBatchById(batch.id);
        expect(unchanged!.quantity).toBe(3);
    });
});
