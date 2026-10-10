import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as productsService from '../src/services/products.service';

/**
 * Contrato de `GET /products` sin término de búsqueda: la página la resuelve
 * Firestore, no la memoria del proceso.
 *
 * Lo que se fija aquí es que ese camino nuevo no se coma ni repita productos en
 * los bordes de página y que `total` siga contando la colección completa y no
 * solo lo leído —el error natural al paginar en el servidor es devolver
 * `total = items.length`, que rompe el paginador del cliente en silencio.
 *
 * Todo se filtra por una categoría propia porque el emulador conserva los
 * productos de las demás suites.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const NAMES = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];

const seedCatalog = async () => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });

    const suffix = unique('x');
    for (const name of NAMES) {
        await productsRepo.createProduct({
            name: `${name}-${suffix}`,
            sku: unique('SKU'),
            categoryId: category.id,
            unit: 'pieza',
            salePrice: 10,
            minStock: 0,
            totalStock: 0,
            hasIva: true,
            hasIvaZero: false,
            hasIeps: false,
            isActive: true,
            requiresPrescription: false,
            suppliers: [],
        });
    }

    return { categoryId: category.id, suffix };
};

const namesOf = (items: Array<{ name: string }>, suffix: string) =>
    items.map((item) => item.name.replace(`-${suffix}`, ''));

describe('listProducts (página resuelta en Firestore)', () => {
    it('pagina en orden de nombre sin repetir ni omitir en los bordes', async () => {
        const { categoryId, suffix } = await seedCatalog();

        const primera = await productsService.listProducts({ categoryId, page: 1, limit: 2 });
        const segunda = await productsService.listProducts({ categoryId, page: 2, limit: 2 });
        const tercera = await productsService.listProducts({ categoryId, page: 3, limit: 2 });

        expect(namesOf(primera.items, suffix)).toEqual(['AAA', 'BBB']);
        expect(namesOf(segunda.items, suffix)).toEqual(['CCC', 'DDD']);
        expect(namesOf(tercera.items, suffix)).toEqual(['EEE']);
    });

    it('cuenta la colección completa en `total`, no solo la página leída', async () => {
        const { categoryId } = await seedCatalog();

        const { meta } = await productsService.listProducts({ categoryId, page: 1, limit: 2 });

        expect(meta.total).toBe(NAMES.length);
        expect(meta.totalPages).toBe(3);
    });

    it('excluye los inactivos salvo que se pidan', async () => {
        const { categoryId, suffix } = await seedCatalog();
        const { items } = await productsService.listProducts({ categoryId, page: 1, limit: 10 });
        await productsRepo.updateProduct(items[0].id, { isActive: false });

        const activos = await productsService.listProducts({ categoryId, page: 1, limit: 10 });
        expect(activos.meta.total).toBe(NAMES.length - 1);
        expect(namesOf(activos.items, suffix)).not.toContain('AAA');

        const todos = await productsService.listProducts({
            categoryId,
            activeOnly: false,
            page: 1,
            limit: 10,
        });
        expect(todos.meta.total).toBe(NAMES.length);
    });

    it('una página fuera de rango sale vacía y conserva el total', async () => {
        const { categoryId } = await seedCatalog();

        const { items, meta } = await productsService.listProducts({
            categoryId,
            page: 9,
            limit: 2,
        });

        expect(items).toEqual([]);
        expect(meta.total).toBe(NAMES.length);
    });
});
