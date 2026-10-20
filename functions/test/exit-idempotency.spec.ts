import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import { ExitContent, runIdempotentExit } from '../src/services/exit-idempotency.service';
import * as inventoryService from '../src/services/inventory.service';
import { AppError } from '../src/utils/errors';
import { toTimestamp } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const fixtures = async (quantity = 10) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Prod'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: quantity,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
    const batch = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2027-06-01'),
        quantity,
    });
    return { product, batch };
};

const exit = (
    f: { product: { id: string }; batch: { id: string } },
    userId: string,
    key: string | undefined,
    quantity = 3,
    notes?: string,
) => {
    const content: ExitContent = {
        productId: f.product.id,
        batchId: f.batch.id,
        quantity,
        reason: 'waste',
        ...(notes ? { notes } : {}),
    };
    return runIdempotentExit({
        userId,
        key,
        content,
        run: () =>
            inventoryService.recordExit({
                productId: f.product.id,
                batchId: f.batch.id,
                quantity,
                reason: 'waste',
                ...(notes ? { notes } : {}),
                userId,
            }),
    });
};

const batchQty = async (id: string) => (await batchesRepo.getBatchById(id))!.quantity;
const stockOf = async (id: string) => (await productsRepo.getProductById(id))!.totalStock;

describe('runIdempotentExit', () => {
    it('el reintento con la misma llave devuelve la salida y no descuenta otra vez', async () => {
        const f = await fixtures();
        const key = unique('key-exit');

        const first = await exit(f, 'u1', key);
        const retry = await exit(f, 'u1', key);

        expect(retry.movement.id).toBe(first.movement.id);
        expect(await batchQty(f.batch.id)).toBe(7);
        expect(await stockOf(f.product.id)).toBe(7);
        expect(retry.batch.quantity).toBe(7);
    });

    it('la repetición refleja el estado actual del lote', async () => {
        const f = await fixtures();
        const key = unique('key-state');

        await exit(f, 'u1', key, 3);
        await exit(f, 'u1', undefined, 2); // otra salida legítima, sin llave
        const retry = await exit(f, 'u1', key, 3);

        expect(retry.batch.quantity).toBe(5);
        expect(await batchQty(f.batch.id)).toBe(5);
    });

    it('sin llave cada llamada es una salida nueva (clientes anteriores)', async () => {
        const f = await fixtures();
        await exit(f, 'u1', undefined);
        await exit(f, 'u1', undefined);
        expect(await batchQty(f.batch.id)).toBe(4);
    });

    it('la misma llave con otro contenido responde 422 y no descuenta', async () => {
        const f = await fixtures();
        const key = unique('key-reuse');

        await exit(f, 'u1', key, 3);
        await expect(exit(f, 'u1', key, 5)).rejects.toMatchObject({ statusCode: 422 });

        expect(await batchQty(f.batch.id)).toBe(7);
    });

    it('la misma llave en otro usuario no se confunde', async () => {
        const f = await fixtures();
        const key = unique('key-shared');

        const a = await exit(f, 'u1', key);
        const b = await exit(f, 'u2', key);

        expect(a.movement.id).not.toBe(b.movement.id);
        expect(await batchQty(f.batch.id)).toBe(4);
    });

    it('dos envíos simultáneos con la misma llave descuentan una sola vez', async () => {
        const f = await fixtures();
        const key = unique('key-race');

        const results = await Promise.allSettled([exit(f, 'u1', key), exit(f, 'u1', key)]);

        expect(await batchQty(f.batch.id)).toBe(7);
        const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        rejected.forEach((r) => expect(r.reason).toBeInstanceOf(AppError));
    });

    it('un fallo de validación libera la llave: la misma llave puede usarse después', async () => {
        const f = await fixtures(2);
        const key = unique('key-fail');

        await expect(exit(f, 'u1', key, 5)).rejects.toBeInstanceOf(AppError);
        expect(await batchQty(f.batch.id)).toBe(2);

        // La llave quedó libre: con la captura corregida se aplica en vez de dar 422.
        const fixed = await exit(f, 'u1', key, 1);
        expect(fixed.movement.id).toBeTruthy();
        expect(await batchQty(f.batch.id)).toBe(1);
    });

    it('una llave reservada sin salida (proceso caído) pide revisión y no duplica', async () => {
        const f = await fixtures();
        const key = unique('key-stuck');
        const content: ExitContent = {
            productId: f.product.id,
            batchId: f.batch.id,
            quantity: 3,
            reason: 'waste',
        };
        await expect(
            runIdempotentExit({
                userId: 'u1',
                key,
                content,
                run: () => Promise.reject(new Error('cae a medias')),
            }),
        ).rejects.toThrow('cae a medias');

        // run falló: la llave se libera y la captura puede reintentarse con la misma llave
        const retry = await exit(f, 'u1', key, 3);
        expect(retry.movement.id).toBeTruthy();
        expect(await batchQty(f.batch.id)).toBe(7);
    });
});
