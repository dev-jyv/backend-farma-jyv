import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as productsService from '../src/services/products.service';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const create = async (name: string, categoryId: string, isActive = true) =>
    productsRepo.createProduct({
        name,
        sku: unique('SKU'),
        categoryId,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive,
        requiresPrescription: false,
        suppliers: [],
    });

describe('búsqueda de productos sobre el snapshot del catálogo', () => {
    afterEach(() => jest.restoreAllMocks());

    it('ya no lee un corte de 500 documentos: pide el catálogo completo', async () => {
        const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
        const token = unique('zzfind');
        await create(`Paracetamol ${token}`, category.id);
        const spy = jest.spyOn(productsRepo, 'listProducts');

        const result = await productsService.listProducts({ search: token, page: 1, limit: 20 });

        expect(result.items.map((item) => item.name)).toEqual([`Paracetamol ${token}`]);
        expect(spy.mock.calls.every(([filters]) => filters.limit === undefined)).toBe(true);
    });

    it('filtra por categoría y por activos dentro de la búsqueda', async () => {
        const catA = await categoriesRepo.createCategory({ name: unique('CatA'), isActive: true });
        const catB = await categoriesRepo.createCategory({ name: unique('CatB'), isActive: true });
        const token = unique('zzmix');
        await create(`Ibuprofeno ${token} A`, catA.id);
        await create(`Ibuprofeno ${token} B`, catB.id);
        await create(`Ibuprofeno ${token} inactivo`, catA.id, false);

        const byCategory = await productsService.listProducts({
            search: token,
            categoryId: catA.id,
            page: 1,
            limit: 20,
        });
        expect(byCategory.items.map((item) => item.name)).toEqual([`Ibuprofeno ${token} A`]);

        const withInactive = await productsService.listProducts({
            search: token,
            activeOnly: false,
            page: 1,
            limit: 20,
        });
        expect(withInactive.items).toHaveLength(3);
    });
});
