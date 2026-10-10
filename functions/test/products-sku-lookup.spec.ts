/**
 * `GET /products?sku=` es la comprobación barata de "¿ya existe este SKU?" que usa el POS
 * antes de dar de alta: una consulta indexada (1 lectura). Con `search`, un SKU inexistente
 * recorría hasta 500 productos. Repositorios simulados: no requiere el emulador.
 */jest.mock('../src/repositories/products.repository');
jest.mock('../src/repositories/categories.repository');
jest.mock('../src/repositories/batches.repository');
import * as productsRepo from '../src/repositories/products.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsService from '../src/services/products.service';

const product = (isActive: boolean) =>
    ({ id: 'p1', sku: 'A-1', name: 'x', categoryId: 'c1', totalStock: 4, isActive }) as never;

beforeEach(() => {
    jest.resetAllMocks();
    (categoriesRepo.getCategoriesByIds as jest.Mock).mockResolvedValue(
        new Map([['c1', { id: 'c1', name: 'cat' }]]),
    );
});

it('usa solo la consulta exacta y nunca recorre la colección', async () => {
    (productsRepo.findProductBySku as jest.Mock).mockResolvedValue(product(true));
    const r = await productsService.listProducts({
        sku: ' A-1 ',
        search: 'ignorado',
        activeOnly: true,
    });
    expect(r.items.map((i) => i.id)).toEqual(['p1']);
    expect(productsRepo.findProductBySku).toHaveBeenCalledWith(' A-1 ');
    expect(productsRepo.listProducts).not.toHaveBeenCalled();
    expect(productsRepo.listProductsPage).not.toHaveBeenCalled();
    expect(productsRepo.findProductBySkuOrBarcode).not.toHaveBeenCalled();
});
it('inexistente => vacío', async () => {
    (productsRepo.findProductBySku as jest.Mock).mockResolvedValue(null);
    const r = await productsService.listProducts({ sku: 'NO' });
    expect(r.items).toEqual([]);
    expect(r.meta.total).toBe(0);
    expect(productsRepo.listProducts).not.toHaveBeenCalled();
});
it('inactivo solo con activeOnly=false', async () => {
    (productsRepo.findProductBySku as jest.Mock).mockResolvedValue(product(false));
    const activos = await productsService.listProducts({ sku: 'A-1', activeOnly: true });
    const todos = await productsService.listProducts({ sku: 'A-1', activeOnly: false });
    expect(activos.items).toEqual([]);
    expect(todos.items).toHaveLength(1);
});
