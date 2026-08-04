import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as invoicesRepo from '../src/repositories/invoices.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as inventoryService from '../src/services/inventory.service';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const createFixtures = async () => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    const product = await productsRepo.createProduct({
        name: unique('Producto'),
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
    const supplier = await suppliersRepo.createSupplier({
        name: unique('Proveedor'),
        isActive: true,
    });
    const invoiceId = invoicesRepo.generateInvoiceId();
    const invoice = await invoicesRepo.createInvoice(
        invoiceId,
        {
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: Timestamp.now(),
            totalAmount: 100,
            hasInvoice: false,
        },
        'test-user',
    );

    return { category, product, supplier, invoice };
};

describe('inventory.service - persistEntryItems (recordEntry)', () => {
    it('crea un lote nuevo, un movimiento de entrada y actualiza el producto', async () => {
        const { product, supplier, invoice } = await createFixtures();

        const entry = await inventoryService.recordEntry({
            invoiceId: invoice.id,
            items: [{
                productId: product.id,
                lotNumber: 'LOTE-1',
                expiryDate: '2027-01-01',
                quantity: 10,
                costPrice: 5,
            }],
            userId: 'test-user',
        });

        expect(entry.items).toHaveLength(1);
        const batchId = entry.items[0].batchId;

        const batch = await batchesRepo.getBatchById(batchId);
        expect(batch).not.toBeNull();
        expect(batch!.quantity).toBe(10);
        expect(batch!.productId).toBe(product.id);

        const updatedProduct = await productsRepo.getProductById(product.id);
        expect(updatedProduct!.suppliers).toContain(supplier.id);
        expect(updatedProduct!.lastCostPriceBySupplier?.[supplier.id]).toBe(5);
    });

    it('incrementa el lote existente cuando coincide producto/lote/caducidad', async () => {
        const { product, invoice } = await createFixtures();

        const first = await inventoryService.recordEntry({
            invoiceId: invoice.id,
            items: [{
                productId: product.id,
                lotNumber: 'LOTE-A',
                expiryDate: '2027-06-01',
                quantity: 5,
            }],
            userId: 'test-user',
        });
        const batchId = first.items[0].batchId;

        await inventoryService.recordEntry({
            invoiceId: invoice.id,
            items: [{
                productId: product.id,
                lotNumber: 'LOTE-A',
                expiryDate: '2027-06-01',
                quantity: 3,
            }],
            userId: 'test-user',
        });

        const batch = await batchesRepo.getBatchById(batchId);
        expect(batch!.quantity).toBe(8);
    });
});

describe('inventory.service - recordExit', () => {
    it('decrementa el lote y crea un movimiento de salida', async () => {
        const { product, invoice } = await createFixtures();

        const entry = await inventoryService.recordEntry({
            invoiceId: invoice.id,
            items: [{
                productId: product.id,
                lotNumber: 'LOTE-EXIT',
                expiryDate: '2027-03-01',
                quantity: 20,
            }],
            userId: 'test-user',
        });
        const batchId = entry.items[0].batchId;

        const { batch, movement } = await inventoryService.recordExit({
            productId: product.id,
            batchId,
            quantity: 7,
            reason: 'waste',
            userId: 'test-user',
        });

        expect(batch.quantity).toBe(13);
        expect(movement.type).toBe('exit_waste');

        const persisted = await batchesRepo.getBatchById(batchId);
        expect(persisted!.quantity).toBe(13);

        const movements = await movementsRepo.listStockMovements({ productId: product.id });
        expect(movements.some((m) => m.id === movement.id && m.type === 'exit_waste')).toBe(true);
    });

    it('no permite oversell con salidas concurrentes', async () => {
        const { product, invoice } = await createFixtures();

        const entry = await inventoryService.recordEntry({
            invoiceId: invoice.id,
            items: [{
                productId: product.id,
                lotNumber: 'LOTE-RACE',
                expiryDate: '2027-03-01',
                quantity: 10,
            }],
            userId: 'test-user',
        });
        const batchId = entry.items[0].batchId;

        const results = await Promise.allSettled([
            inventoryService.recordExit({
                productId: product.id,
                batchId,
                quantity: 7,
                reason: 'waste',
                userId: 'test-user-a',
            }),
            inventoryService.recordExit({
                productId: product.id,
                batchId,
                quantity: 7,
                reason: 'expiry',
                userId: 'test-user-b',
            }),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const persisted = await batchesRepo.getBatchById(batchId);
        expect(persisted!.quantity).toBe(3);
    });
});

describe('inventory.service - recordDirectEntry (bug (a) guard)', () => {
    it('no deja un producto huérfano si un ítem posterior falla la validación', async () => {
        const { category, supplier, product: existingProduct } = await createFixtures();

        const inlineProductName = unique('ProductoInline');
        const inlineSku = unique('SKU-INLINE');

        await expect(
            inventoryService.recordDirectEntry({
                supplierId: supplier.id,
                items: [
                    {
                        product: {
                            name: inlineProductName,
                            sku: inlineSku,
                            categoryId: category.id,
                            unit: 'unidad',
                            salePrice: 10,
                            minStock: 1,
                            hasIva: true,
                            hasIvaZero: false,
                            hasIeps: false,
                        },
                        expiryDate: '2027-01-01',
                        quantity: 5,
                    },
                    {
                        productId: existingProduct.id,
                        expiryDate: 'fecha-invalida',
                        quantity: 1,
                    },
                ],
                userId: 'test-user',
            }),
        ).rejects.toThrow();

        const snapshot = await admin.firestore()
            .collection('products')
            .where('sku', '==', inlineSku)
            .limit(1)
            .get();
        expect(snapshot.empty).toBe(true);
    });
});
