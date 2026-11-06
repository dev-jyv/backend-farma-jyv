import { AppExceptionFilter } from '../src/common/app-exception.filter';
import { ProductsController } from '../src/modules/catalog/products.controller';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import { updateProductSchema } from '../src/schemas';
import * as productsService from '../src/services/products.service';
import { AppError } from '../src/utils/errors';
import { AuthUser, Product } from '../src/types';

/**
 * SPEC 56, puntos 3 y 5 (backend).
 *
 * - Un PATCH de la caja hecho sobre una copia vieja no revierte un precio ni un
 *   `isActive` que el panel cambió después: responde 409 `CATALOG_CONFLICT` con
 *   el valor vigente, y los demás campos del PATCH se aplican igual.
 * - El pull devuelve `meta.serverTime` tomado antes de leer, para que la caja
 *   use un cursor que nunca se salta un cambio.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const ADMIN = { userId: 'admin-1', roleSlug: 'admin' };

const crearProducto = async (): Promise<Product> => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'caja',
        salePrice: 100,
        minStock: 0,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        concentration: '500 mg',
        suppliers: [],
    });
};

const pausa = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * La caja copió el producto (su `updatedAt` es la base) y después el admin
 * cambió algo en el panel.
 */
const copiaDeLaCajaYCambioDelPanel = async (
    cambio: { salePrice?: number; isActive?: boolean },
) => {
    const product = await crearProducto();
    const baseUpdatedAt = product.updatedAt.toDate().toISOString();
    await pausa(5);
    await productsService.updateProduct(product.id, cambio, ADMIN);
    return { product, baseUpdatedAt };
};

const capturar = async (promise: Promise<unknown>): Promise<AppError> => {
    try {
        await promise;
    } catch (error) {
        return error as AppError;
    }
    throw new Error('Se esperaba un error');
};

describe('PATCH /products/:id con baseUpdatedAt (SPEC 56)', () => {
    it('base vieja que toca salePrice responde 409 y respeta el precio del panel', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });

        const error = await capturar(productsService.updateProduct(
            product.id,
            { salePrice: 90 },
            { userId: 'cajero-1', roleSlug: 'cashier' },
            { baseUpdatedAt },
        ));

        expect(error).toBeInstanceOf(AppError);
        expect(error.statusCode).toBe(409);
        expect(error.syncCode).toBe('CATALOG_CONFLICT');
        expect(error.retryable).toBe(false);
        expect(error.details).toEqual({ current: { salePrice: 120, isActive: true } });

        const guardado = await productsRepo.getProductById(product.id);
        expect(guardado?.salePrice).toBe(120);
    });

    it('uno que toca solo concentration se aplica', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });

        const updated = await productsService.updateProduct(
            product.id,
            { concentration: '250 mg' },
            undefined,
            { baseUpdatedAt },
        );

        expect(updated.concentration).toBe('250 mg');
        expect(updated.salePrice).toBe(120);
    });

    it('el campo del cajero se aplica y el precio del panel se respeta', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });

        const error = await capturar(productsService.updateProduct(
            product.id,
            { salePrice: 90, concentration: '1 g' },
            undefined,
            { baseUpdatedAt },
        ));

        expect(error.statusCode).toBe(409);
        const guardado = await productsRepo.getProductById(product.id);
        expect(guardado?.salePrice).toBe(120);
        expect(guardado?.concentration).toBe('1 g');
    });

    it('no reactiva un producto que el panel dio de baja después de la copia', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ isActive: false });

        const error = await capturar(productsService.updateProduct(
            product.id,
            { isActive: true },
            undefined,
            { baseUpdatedAt },
        ));

        expect(error.statusCode).toBe(409);
        expect(error.details).toEqual({ current: { salePrice: 100, isActive: false } });
        expect((await productsRepo.getProductById(product.id))?.isActive).toBe(false);
    });

    it('un conflicto sin nada más que escribir no sube updatedAt', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });
        const antes = await productsRepo.getProductById(product.id);

        await capturar(productsService.updateProduct(
            product.id,
            { salePrice: 90 },
            undefined,
            { baseUpdatedAt },
        ));

        const despues = await productsRepo.getProductById(product.id);
        expect(despues?.updatedAt.toMillis()).toBe(antes?.updatedAt.toMillis());
    });

    it('sin baseUpdatedAt (panel o "forzar el mío") se aplica como siempre', async () => {
        const { product } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });

        const updated = await productsService.updateProduct(product.id, { salePrice: 90 });

        expect(updated.salePrice).toBe(90);
    });

    it('con una base posterior al cambio del panel no hay conflicto', async () => {
        const { product } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });
        const fresca = await productsRepo.getProductById(product.id);

        const updated = await productsService.updateProduct(
            product.id,
            { salePrice: 130 },
            undefined,
            { baseUpdatedAt: fresca!.updatedAt.toDate().toISOString() },
        );

        expect(updated.salePrice).toBe(130);
    });

    it('mandar el mismo valor vigente no es conflicto', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });

        const updated = await productsService.updateProduct(
            product.id,
            { salePrice: 120, concentration: '2 g' },
            undefined,
            { baseUpdatedAt },
        );

        expect(updated.concentration).toBe('2 g');
    });

    it('un cambio de stock (updatedAt) no cuenta como cambio de precio', async () => {
        const product = await crearProducto();
        const baseUpdatedAt = product.updatedAt.toDate().toISOString();
        await pausa(5);
        await productsRepo.updateProduct(product.id, { totalStock: 7 });

        const updated = await productsService.updateProduct(
            product.id,
            { salePrice: 95 },
            undefined,
            { baseUpdatedAt },
        );

        expect(updated.salePrice).toBe(95);
    });

    it('el controller separa baseUpdatedAt y el filtro manda details.current', async () => {
        const { product, baseUpdatedAt } = await copiaDeLaCajaYCambioDelPanel({ salePrice: 120 });
        const body = updateProductSchema.parse({ salePrice: 80, baseUpdatedAt });
        const user = {
            uid: 'cajero-1',
            role: { id: 'r', slug: 'cashier', name: 'Cajero' },
            permissions: [],
        } as unknown as AuthUser;

        const error = await capturar(
            new ProductsController().update({ id: product.id }, body, user),
        );

        const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const host = {
            switchToHttp: () => ({
                getResponse: () => response,
                getRequest: () => ({ method: 'PATCH', originalUrl: '/v1/products/x' }),
            }),
        };
        new AppExceptionFilter().catch(error, host as never);

        expect(response.status).toHaveBeenCalledWith(409);
        expect(response.json).toHaveBeenCalledWith({
            error: {
                code: 'CONFLICT',
                message: expect.any(String),
                details: {
                    code: 'CATALOG_CONFLICT',
                    retryable: false,
                    current: { salePrice: 120, isActive: true },
                },
            },
        });
        // `baseUpdatedAt` es una precondición, no un campo del producto.
        const guardado = await productsRepo.getProductById(product.id);
        expect(guardado).not.toHaveProperty('baseUpdatedAt');
    });
});

describe('meta.serverTime en el pull (SPEC 56)', () => {
    beforeEach(() => productsService.clearProductsSyncCache());

    it('GET /products/sync lo devuelve tomado antes de leer (completa e incremental)', async () => {
        await crearProducto();
        const controller = new ProductsController();

        const antes = Date.now();
        const completa = await controller.sync({});
        const despues = Date.now();
        const serverTime = Date.parse(completa.meta.serverTime);
        expect(serverTime).toBeGreaterThanOrEqual(antes);
        expect(serverTime).toBeLessThanOrEqual(despues);

        const delta = await controller.sync({ updatedSince: new Date(antes).toISOString() });
        expect(Date.parse(delta.meta.serverTime)).toBeGreaterThanOrEqual(despues);
    });

    it('un cambio confirmado durante la lectura queda después del cursor', async () => {
        const product = await crearProducto();
        const { serverTime } = await productsService.listProductsForSync({
            updatedSince: new Date(Date.now() - 60_000).toISOString(),
        });
        await productsRepo.updateProduct(product.id, { totalStock: 3 });

        const siguiente = await productsService.listProductsForSync({ updatedSince: serverTime });
        expect(siguiente.items.map((item) => item.id)).toContain(product.id);
    });

    it('GET /products con updatedSince también lo devuelve; sin él, no', async () => {
        await crearProducto();
        const antes = Date.now();

        const delta = await productsService.listProducts({
            activeOnly: false,
            updatedSince: new Date(antes - 60_000).toISOString(),
        });
        expect(Date.parse(delta.meta.serverTime!)).toBeGreaterThanOrEqual(antes);

        const pagina = await productsService.listProducts({});
        expect(pagina.meta).not.toHaveProperty('serverTime');
    });
});
