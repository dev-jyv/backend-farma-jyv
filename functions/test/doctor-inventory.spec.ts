import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Timestamp } from 'firebase-admin/firestore';
import { SYSTEM_ROLE_DEFINITIONS } from '../src/constants/permissions';
import { DoctorInventoryController } from '../src/modules/clinic/doctor-inventory.controller';
import { PermissionsGuard } from '../src/modules/identity/guards/permissions.guard';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { doctorInventoryQuerySchema } from '../src/schemas';
import * as doctorInventory from '../src/services/doctor-inventory.service';
import * as inventoryService from '../src/services/inventory.service';
import { AuthUser, RolePermission } from '../src/types';

/**
 * `GET /v1/doctor/inventory`: acceso (solo admin y doctor), contenido sin datos
 * comerciales, carga completa vs delta, caché de 60 s y cursor `serverTime`.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const guard = new PermissionsGuard(new Reflector());

const contexto = (authUser?: AuthUser): ExecutionContext =>
    ({
        getHandler: () => DoctorInventoryController.prototype.list,
        getClass: () => DoctorInventoryController,
        switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
    }) as unknown as ExecutionContext;

const usuario = (slug: string, permissions: RolePermission[]): AuthUser =>
    ({
        uid: 'u1',
        email: 'x@y.z',
        role: { id: 'r1', slug, name: slug },
        permissions,
    }) as unknown as AuthUser;

const deSistema = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS) =>
    usuario(slug, SYSTEM_ROLE_DEFINITIONS[slug].permissions);

let categoryId: string;

const crearProducto = (overrides: Partial<Parameters<typeof productsRepo.createProduct>[0]> = {}) =>
    productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId,
        unit: 'caja',
        salePrice: 99,
        minStock: 2,
        totalStock: 5,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
        ...overrides,
    });

/** Este spec cuenta productos: cada caso parte de una base vacía. */
const limpiarFirestore = async () => {
    const host = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
    const project = process.env.GCLOUD_PROJECT || 'farma-jyv-test';
    const response = await fetch(
        `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
        { method: 'DELETE' },
    );
    if (!response.ok) {
        throw new Error(`No se pudo limpiar el emulador (${response.status})`);
    }
};

beforeEach(async () => {
    await limpiarFirestore();
    doctorInventory.clearDoctorInventoryCache();
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    categoryId = category.id;
});

describe('GET /doctor/inventory - acceso', () => {
    it('admin y doctor pasan', () => {
        expect(guard.canActivate(contexto(deSistema('admin')))).toBe(true);
        expect(guard.canActivate(contexto(deSistema('doctor')))).toBe(true);
    });

    it.each(['manager', 'cashier'] as const)('%s recibe 403', (slug) => {
        expect(() => guard.canActivate(contexto(deSistema(slug)))).toThrow(
            expect.objectContaining({ statusCode: 403 }),
        );
    });

    it('un rol custom sin medicalRecords recibe 403, aunque tenga products y doctor', () => {
        const custom = usuario('custom', [
            { area: 'products', level: 'write' },
            { area: 'doctor', level: 'write' },
            { area: 'patients', level: 'write' },
        ]);
        expect(() => guard.canActivate(contexto(custom))).toThrow(
            expect.objectContaining({ statusCode: 403 }),
        );
    });

    it('un rol custom con medicalRecords:read pasa', () => {
        const custom = usuario('custom', [{ area: 'medicalRecords', level: 'read' }]);
        expect(guard.canActivate(contexto(custom))).toBe(true);
    });

    it('sin usuario autenticado responde 401', () => {
        expect(() => guard.canActivate(contexto(undefined))).toThrow(
            expect.objectContaining({ statusCode: 401 }),
        );
    });
});

describe('GET /doctor/inventory - carga completa', () => {
    it('trae solo activos, ordenados por nombre y sin campos sensibles', async () => {
        const sufijo = unique('x');
        await crearProducto({ name: `Zeta ${sufijo}` });
        await crearProducto({ name: `Alfa ${sufijo}`, activeIngredient: 'Paracetamol' });
        await crearProducto({ name: `Inactivo ${sufijo}`, isActive: false });

        const { items, meta } = await doctorInventory.getDoctorInventory();

        const nombres = items.map((item) => item.name);
        expect(nombres).toEqual([`Alfa ${sufijo}`, `Zeta ${sufijo}`]);
        expect(meta).toMatchObject({ full: true, total: 2 });
        expect(Number.isNaN(Date.parse(meta.serverTime))).toBe(false);

        expect(Object.keys(items[0]).sort()).toEqual(
            [
                'id',
                'name',
                'activeIngredient',
                'concentration',
                'unit',
                'categoryId',
                'totalStock',
                'minStock',
                'controlledGroup',
                'isActive',
                'updatedAt',
            ].sort(),
        );
        const serializado = JSON.stringify(items);
        expect(serializado).not.toMatch(/salePrice|costPrice|suppliers|sku/);
        expect(items[0].activeIngredient).toBe('Paracetamol');
        expect(items[1].activeIngredient).toBeNull();
    });
});

describe('GET /doctor/inventory - caché', () => {
    it('una segunda carga completa dentro del TTL no relee Firestore', async () => {
        await crearProducto();
        const spy = jest.spyOn(productsRepo, 'listProducts');
        try {
            const primera = await doctorInventory.getDoctorInventory();
            const segunda = await doctorInventory.getDoctorInventory();
            expect(spy).toHaveBeenCalledTimes(1);
            expect(segunda.items).toEqual(primera.items);

            // El producto nuevo no aparece hasta que expire la caché.
            await crearProducto();
            const tercera = await doctorInventory.getDoctorInventory();
            expect(tercera.items).toHaveLength(1);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

    it('expira pasado el TTL', async () => {
        await crearProducto();
        const spy = jest.spyOn(productsRepo, 'listProducts');
        const nowSpy = jest.spyOn(Date, 'now');
        try {
            await doctorInventory.getDoctorInventory();
            nowSpy.mockReturnValue(Date.now() + 61_000);
            await crearProducto();
            const despues = await doctorInventory.getDoctorInventory();
            expect(spy).toHaveBeenCalledTimes(2);
            expect(despues.items).toHaveLength(2);
        } finally {
            nowSpy.mockRestore();
            spy.mockRestore();
        }
    });

    it('el delta no pasa por la caché', async () => {
        const producto = await crearProducto();
        await doctorInventory.getDoctorInventory();
        const spy = jest.spyOn(productsRepo, 'listProducts');
        try {
            await doctorInventory.getDoctorInventory('2000-01-01T00:00:00.000Z');
            await doctorInventory.getDoctorInventory('2000-01-01T00:00:00.000Z');
            expect(spy).toHaveBeenCalledTimes(2);
            expect(producto.id).toBeTruthy();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('GET /doctor/inventory - delta por updatedSince', () => {
    it('devuelve solo lo cambiado, incluye inactivos y serverTime sirve de cursor', async () => {
        const estable = await crearProducto();
        const aDesactivar = await crearProducto();

        const base = await doctorInventory.getDoctorInventory();
        const cursor = base.meta.serverTime;
        expect(base.items.map((i) => i.id)).toContain(estable.id);

        await sleep(20);
        await productsRepo.updateProduct(aDesactivar.id, { isActive: false });

        const delta = await doctorInventory.getDoctorInventory(cursor);
        expect(delta.meta).toMatchObject({ full: false, total: 1 });
        expect(delta.items.map((i) => i.id)).toEqual([aDesactivar.id]);
        expect(delta.items[0].isActive).toBe(false);

        // Con el serverTime del delta como nuevo cursor ya no hay nada pendiente.
        await sleep(20);
        const vacio = await doctorInventory.getDoctorInventory(delta.meta.serverTime);
        expect(vacio.items).toEqual([]);
        expect(vacio.meta.total).toBe(0);
    });

    it('un ajuste de stock mueve updatedAt y aparece en el delta', async () => {
        const supplier = await suppliersRepo.createSupplier({
            name: unique('Proveedor'),
            isActive: true,
        });
        const producto = await crearProducto({ totalStock: 0 });
        const otro = await crearProducto({ totalStock: 0 });

        const cursor = (await doctorInventory.getDoctorInventory()).meta.serverTime;
        await sleep(20);

        await inventoryService.recordDirectEntry({
            supplierId: supplier.id,
            userId: 'test-user',
            items: [{
                productId: producto.id,
                lotNumber: 'L-1',
                expiryDate: '2030-01-01',
                quantity: 7,
                costPrice: 3,
            }],
        });

        const delta = await doctorInventory.getDoctorInventory(cursor);
        expect(delta.items.map((i) => i.id)).toEqual([producto.id]);
        expect(delta.items[0].totalStock).toBe(7);
        expect(delta.items.map((i) => i.id)).not.toContain(otro.id);
    });

    it('devuelve updatedAt en ISO', async () => {
        await crearProducto();
        const { items } = await doctorInventory.getDoctorInventory();
        expect(new Date(items[0].updatedAt).toISOString()).toBe(items[0].updatedAt);
        expect(Timestamp.now().toMillis() - Date.parse(items[0].updatedAt)).toBeLessThan(60_000);
    });
});

describe('doctorInventoryQuerySchema', () => {
    it('acepta sin updatedSince y con una fecha ISO', () => {
        expect(doctorInventoryQuerySchema.safeParse({}).success).toBe(true);
        expect(
            doctorInventoryQuerySchema.safeParse({ updatedSince: '2026-01-01T00:00:00.000Z' })
                .success,
        ).toBe(true);
    });

    it('rechaza un updatedSince inválido (400 vía ZodValidationPipe)', () => {
        expect(doctorInventoryQuerySchema.safeParse({ updatedSince: 'ayer' }).success).toBe(false);
        expect(doctorInventoryQuerySchema.safeParse({ updatedSince: '' }).success).toBe(false);
    });
});
