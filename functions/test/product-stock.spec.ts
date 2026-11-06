import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Timestamp } from 'firebase-admin/firestore';
import { SYSTEM_ROLE_DEFINITIONS } from '../src/constants/permissions';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import { PermissionsGuard } from '../src/modules/identity/guards/permissions.guard';
import { ProductsController } from '../src/modules/catalog/products.controller';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as productsService from '../src/services/products.service';
import { AppError } from '../src/utils/errors';
import { AuthUser, RolePermission } from '../src/types';

/**
 * `GET /products/:id/stock` (SPEC 57). La caja lo llama cuando su stock local no
 * alcanza, antes de negar la venta: la mercancía que recibió otra caja no llega
 * hasta el siguiente pull y el producto se queda en el anaquel sin venderse.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const daysFromNow = (days: number): Timestamp =>
    Timestamp.fromDate(new Date(Date.now() + days * 86_400_000));

const crearProducto = async (totalStock?: number) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'caja',
        salePrice: 50,
        minStock: 0,
        ...(totalStock === undefined ? {} : { totalStock }),
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
};

describe('getProductStock', () => {
    it('devuelve total, updatedAt y solo los lotes con piezas, por caducidad', async () => {
        const product = await crearProducto(5);
        const lejano = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'L-LEJANO',
            expiryDate: daysFromNow(200),
            quantity: 3,
        });
        const proximo = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'L-PROXIMO',
            expiryDate: daysFromNow(10),
            quantity: 2,
        });
        await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'L-AGOTADO',
            expiryDate: daysFromNow(5),
            quantity: 0,
        });

        const stock = await productsService.getProductStock(product.id);

        expect(Object.keys(stock).sort()).toEqual(['batches', 'id', 'totalStock', 'updatedAt']);
        expect(stock.id).toBe(product.id);
        expect(stock.totalStock).toBe(5);
        expect(stock.updatedAt.toMillis()).toBe(product.updatedAt.toMillis());
        expect(stock.batches.map((batch) => batch.id)).toEqual([proximo.id, lejano.id]);
        expect(Object.keys(stock.batches[0]).sort())
            .toEqual(['expiryDate', 'id', 'lotNumber', 'quantity']);
        expect(stock.batches[0]).toMatchObject({ lotNumber: 'L-PROXIMO', quantity: 2 });
    });

    it('sin `totalStock` denormalizado suma los lotes ya leídos', async () => {
        const product = await crearProducto();
        await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'L-1',
            expiryDate: daysFromNow(30),
            quantity: 4,
        });

        const stock = await productsService.getProductStock(product.id);
        expect(stock.totalStock).toBe(4);
    });

    it('un producto inexistente es 404', async () => {
        await expect(productsService.getProductStock('no-existe')).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});

describe('permiso de GET /products/:id/stock', () => {
    const proto = ProductsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >;
    const usuario = (slug: string, permissions: RolePermission[]): AuthUser => ({
        uid: 'u1',
        email: 'x@y.z',
        role: { id: 'r1', slug, name: slug },
        permissions,
    } as unknown as AuthUser);
    const contexto = (authUser: AuthUser): ExecutionContext => ({
        getHandler: () => proto.stock,
        getClass: () => ProductsController,
        switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
    } as unknown as ExecutionContext);
    const guard = new PermissionsGuard(new Reflector());
    const pasa = (user: AuthUser): boolean | number => {
        try {
            return guard.canActivate(contexto(user));
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            return (error as AppError).statusCode;
        }
    };

    it('se declara products:read', () => {
        const metadato = new Reflector().getAllAndOverride(PERMISSION_KEY, [
            proto.stock,
            ProductsController,
        ]);
        expect(metadato).toEqual({ area: 'products', level: 'read' });
    });

    it('el cajero la puede llamar (tiene products:read)', () => {
        expect(pasa(usuario('cashier', SYSTEM_ROLE_DEFINITIONS.cashier.permissions))).toBe(true);
    });

    it('un rol sin products responde 403', () => {
        expect(pasa(usuario('custom', [{ area: 'pos', level: 'write' }]))).toBe(403);
    });
});
