const listProducts = jest.fn();
const listBatchesWithStock = jest.fn();
jest.mock('../src/repositories/products.repository', () => ({ listProducts }));
jest.mock('../src/repositories/batches.repository', () => ({ listBatchesWithStock }));

import * as snapshot from '../src/services/catalog-snapshot.service';

const product = (id: string, isActive: boolean) => ({ id, name: id, isActive });

describe('catalog-snapshot', () => {
    beforeEach(() => {
        process.env.CATALOG_SNAPSHOT_TTL_MS = '60000';
        snapshot.clearCatalogSnapshot();
        listProducts.mockReset();
        listBatchesWithStock.mockReset();
        listProducts.mockResolvedValue([product('a', true), product('b', false)]);
        listBatchesWithStock.mockResolvedValue([{ id: 'l1' }]);
    });

    afterAll(() => {
        process.env.CATALOG_SNAPSHOT_TTL_MS = '0';
    });

    it('activos e inactivos comparten una sola lectura', async () => {
        const active = await snapshot.listProducts({ activeOnly: true });
        const all = await snapshot.listProducts({ activeOnly: false });
        const byDefault = await snapshot.listProducts({});

        expect(active.map((p) => p.id)).toEqual(['a']);
        expect(all.map((p) => p.id)).toEqual(['a', 'b']);
        expect(byDefault.map((p) => p.id)).toEqual(['a']);
        expect(listProducts).toHaveBeenCalledTimes(1);
        expect(listProducts).toHaveBeenCalledWith({ activeOnly: false });
    });

    it('peticiones concurrentes en frío comparten la lectura', async () => {
        await Promise.all([
            snapshot.listBatchesWithStock(),
            snapshot.listBatchesWithStock(),
            snapshot.listBatchesWithStock(),
        ]);
        expect(listBatchesWithStock).toHaveBeenCalledTimes(1);
    });

    it('entrega copias: ordenar el resultado no altera la caché', async () => {
        const first = await snapshot.listProducts({ activeOnly: false });
        first.reverse();
        const second = await snapshot.listProducts({ activeOnly: false });
        expect(second.map((p) => p.id)).toEqual(['a', 'b']);
    });

    it('un fallo no se cachea', async () => {
        listBatchesWithStock.mockRejectedValueOnce(new Error('boom'));
        await expect(snapshot.listBatchesWithStock()).rejects.toThrow('boom');
        await expect(snapshot.listBatchesWithStock()).resolves.toEqual([{ id: 'l1' }]);
        expect(listBatchesWithStock).toHaveBeenCalledTimes(2);
    });

    it('con TTL 0 cada llamada relee', async () => {
        process.env.CATALOG_SNAPSHOT_TTL_MS = '0';
        await snapshot.listBatchesWithStock();
        await snapshot.listBatchesWithStock();
        expect(listBatchesWithStock).toHaveBeenCalledTimes(2);
    });
});
