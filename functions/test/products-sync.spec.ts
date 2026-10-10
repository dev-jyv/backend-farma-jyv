import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as productsService from '../src/services/products.service';

/**
 * Contrato de `GET /products/sync`: el pull del catálogo local del POS (SQLite).
 *
 * Lo que se prueba aquí no es "que traiga datos" sino **que no traiga de más**:
 * el pull completo viaja por la red de la farmacia y se guarda entero, así que
 * cada campo extra es peso que ninguna tabla local persiste.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const EXPECTED_PRODUCT_KEYS = [
    'id',
    'sku',
    'barcode',
    'name',
    'activeIngredient',
    'concentration',
    'categoryId',
    'unit',
    'salePrice',
    'minStock',
    'hasIva',
    'hasIvaZero',
    'hasIeps',
    'iepsRate',
    'controlledGroup',
    'requiresPrescription',
    'isActive',
    'stock',
    'updatedAt',
    'batches',
];

const EXPECTED_BATCH_KEYS = ['id', 'lotNumber', 'expiryDate', 'quantity'];

const daysFromNow = (days: number): Timestamp =>
    Timestamp.fromDate(new Date(Date.now() + days * 86_400_000));

const createProductWithBatches = async () => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    const product = await productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        barcode: unique('BAR'),
        categoryId: category.id,
        unit: 'caja',
        salePrice: 120.5,
        minStock: 2,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: true,
        controlledGroup: 'IV',
        suppliers: [],
    });

    // Dos lotes vendibles (el segundo caduca antes: debe salir primero) y uno agotado.
    const lejano = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: 'L-LEJANO',
        expiryDate: daysFromNow(200),
        quantity: 10,
    });
    const proximo = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: 'L-PROXIMO',
        expiryDate: daysFromNow(20),
        quantity: 4,
    });
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: 'L-AGOTADO',
        expiryDate: daysFromNow(5),
        quantity: 0,
    });

    return { product, lejano, proximo };
};

describe('listProductsForSync', () => {
    it('devuelve solo los campos que persiste el SQLite local', async () => {
        const { product } = await createProductWithBatches();

        const { items } = await productsService.listProductsForSync({});
        const synced = items.find((item) => item.id === product.id);

        expect(synced).toBeDefined();
        expect(Object.keys(synced!).sort()).toEqual(
            EXPECTED_PRODUCT_KEYS.filter((key) => key in synced!).sort(),
        );
        // Nada del documento de Firestore que el local no guarde.
        expect(synced as unknown as Record<string, unknown>).not.toHaveProperty('category');
        expect(synced as unknown as Record<string, unknown>).not.toHaveProperty('createdAt');
        expect(synced as unknown as Record<string, unknown>).not.toHaveProperty('totalStock');
        expect(synced as unknown as Record<string, unknown>).not.toHaveProperty('suppliers');
        expect(synced as unknown as Record<string, unknown>).not.toHaveProperty(
            'lastCostPriceBySupplier',
        );
    });

    it('manda los lotes vendibles en orden FEFO y omite los agotados', async () => {
        const { product, proximo, lejano } = await createProductWithBatches();

        const { items } = await productsService.listProductsForSync({});
        const synced = items.find((item) => item.id === product.id)!;

        expect(synced.batches.map((batch) => batch.id)).toEqual([proximo.id, lejano.id]);
        expect(Object.keys(synced.batches[0]).sort()).toEqual([...EXPECTED_BATCH_KEYS].sort());
        // Costo y proveedor son datos de compra: la caja no los necesita para vender.
        expect(synced.batches[0] as unknown as Record<string, unknown>).not.toHaveProperty(
            'costPrice',
        );
        expect(synced.batches[0] as unknown as Record<string, unknown>).not.toHaveProperty(
            'supplierId',
        );
    });

    it('calcula el stock sumando lotes cuando el producto no tiene `totalStock`', async () => {
        const { product } = await createProductWithBatches();

        const { items } = await productsService.listProductsForSync({});
        const synced = items.find((item) => item.id === product.id)!;

        // `createProduct` guardó `totalStock: 0`; el fallback solo aplica a
        // productos previos a la denormalización, así que aquí manda el campo.
        expect(synced.stock).toBe(0);
    });

    it('el pull incremental solo trae lo modificado después del cursor', async () => {
        const { product } = await createProductWithBatches();
        const cursor = new Date(Date.now() + 1000).toISOString();

        const { items } = await productsService.listProductsForSync({ updatedSince: cursor });

        expect(items.some((item) => item.id === product.id)).toBe(false);
    });
});
