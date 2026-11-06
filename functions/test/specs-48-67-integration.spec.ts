import 'reflect-metadata';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { AppModule } from '../src/app.module';
import { createHttpApp } from '../src/common/http-pipeline';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import { createUserProfile } from '../src/repositories/users.repository';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as productsService from '../src/services/products.service';
import * as unreconciledService from '../src/services/unreconciled-sales.service';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

/**
 * Integración de las tres líneas de SPEC 48–67 (ventas, entradas, operación).
 * Fija lo que solo se ve con las tres juntas:
 *
 * - «Registrar» una venta no conciliada (SPEC 53, operación) sigue la política
 *   de turno cerrado de SPEC 52 (ventas): si se cobró antes del cierre entra al
 *   turno como `lateSync`, con ajuste pendiente; si se cobró después, 400 y
 *   sigue pendiente.
 * - El filtro de turnos `needsReview=true` que manda el POS (SPEC 63) pasa por
 *   todo el pipeline HTTP (guards + Zod) y filtra en el servidor.
 */

const CAJERO = 'cajero-integ';
const GERENTE = { userId: 'gerente-integ', roleSlug: 'manager' };
const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

let categoryId: string;

beforeAll(async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    categoryId = category.id;
});

/** Producto con un lote de 10 piezas a $50. */
const crearProducto = async () => {
    const product = await productsService.createProduct({
        name: unique('Paracetamol'),
        sku: unique('SKU'),
        categoryId,
        unit: 'pieza',
        salePrice: 50,
        minStock: 1,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
    } as Parameters<typeof productsService.createProduct>[0]);
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('L'),
        expiryDate: toTimestamp('2028-01-01'),
        quantity: 10,
        costPrice: 20,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 10 });
    return product;
};

/** Turno abierto hace 3 h y cerrado hace 30 min, con su ajuste ya aprobado. */
const turnoCerrado = async () => {
    const session = await cashSessionsRepo.createCashSession({
        openedBy: CAJERO,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });
    await db().collection('cashSessions').doc(session.id).update({
        openedAt: Timestamp.fromDate(minutesAgo(180)),
        closedAt: Timestamp.fromDate(minutesAgo(30)),
        closedBy: CAJERO,
        hasPendingAdjustment: false,
        adjustmentStatus: 'approved',
    });
    return session;
};

const altaNoConciliada = (productId: string, cashSessionId: string, occurredAt: Date) =>
    unreconciledService.recordUnreconciledSale({
        localId: unique('local'),
        deviceId: 'caja-integ',
        reason: 'Producto no encontrado en el servidor',
        total: 100,
        occurredAt: occurredAt.toISOString(),
        cashSessionId,
        cashierId: CAJERO,
        roleSlug: 'cashier',
        payload: {
            idempotencyKey: unique('llave'),
            items: [{ productId, quantity: 2, unitPrice: 50 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId,
        },
    });

describe('SPEC 52 + SPEC 53 — registrar una no conciliada de un turno ya cerrado', () => {
    it('cobrada antes del cierre: entra al turno como lateSync con ajuste pendiente',
        async () => {
            const product = await crearProducto();
            const turno = await turnoCerrado();
            const pendiente = await altaNoConciliada(product.id, turno.id, minutesAgo(60));

            // Antes de registrarla, el efectivo está en el resumen como no conciliado.
            const antes = await cashSessionsService.getSessionSummary(turno.id, CAJERO, 'cashier');
            expect(antes.summary.unreconciledCash).toBe(100);

            const { unreconciled, sale } = await unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            );

            expect(unreconciled.resolution).toBe('register');
            expect(sale?.cashSessionId).toBe(turno.id);
            expect(sale?.lateSync).toBe(true);
            expect(sale?.cashierId).toBe(CAJERO);

            const stored = await cashSessionsRepo.getCashSessionById(turno.id);
            expect(stored?.hasPendingAdjustment).toBe(true);
            expect(stored?.adjustmentStatus).toBe('pending');
            expect(stored?.lateSales).toEqual({ count: 1, cashTotal: 100 });

            // Ya registrada, deja de contarse como no conciliada.
            const despues = await cashSessionsService.getSessionSummary(
                turno.id, CAJERO, 'cashier',
            );
            expect(despues.summary.unreconciledCash).toBe(0);
            expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(8);
        });

    it('cobrada después del cierre: 400 SESSION_CLOSED y sigue pendiente', async () => {
        const product = await crearProducto();
        const turno = await turnoCerrado();
        const pendiente = await altaNoConciliada(product.id, turno.id, minutesAgo(10));

        const error = await unreconciledService.resolveUnreconciledSale(
            pendiente.id, { action: 'register' }, GERENTE,
        ).then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
        expect((error as AppError).syncCode).toBe('SESSION_CLOSED');

        const doc = await db().collection('unreconciledSales').doc(pendiente.id).get();
        expect(doc.get('resolvedAt')).toBeNull();
        expect((await cashSessionsRepo.getCashSessionById(turno.id))?.lateSales)
            .toBeUndefined();
    });
});

describe('SPEC 63 — GET /v1/cash-sessions?needsReview=true por HTTP', () => {
    const ADMIN = 'uid-admin-integ';
    let server: Server;
    let base: string;

    beforeAll(async () => {
        await createUserProfile(ADMIN, {
            email: 'admin@farmajyv.test',
            displayName: 'Admin',
            roleId: 'rol-admin',
            permissionsVersion: 1,
            isActive: true,
        });
        jest.spyOn(admin, 'auth').mockReturnValue({
            verifyIdToken: jest.fn(async (token: string) => {
                if (token !== 'token-admin') {
                    throw Object.assign(new Error('Firebase ID token has expired.'), {
                        code: 'auth/id-token-expired',
                    });
                }
                return {
                    uid: ADMIN,
                    auth_time: Math.floor(Date.now() / 1000),
                    roleId: 'rol-admin',
                    roleSlug: 'admin',
                    roleName: 'Admin',
                    permissions: [],
                    permissionsVersion: 1,
                };
            }),
        } as unknown as admin.auth.Auth);
        const app: express.Application = await createHttpApp(AppModule);
        server = app.listen(0);
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        jest.restoreAllMocks();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('acepta la consulta exacta del POS y filtra en el servidor', async () => {
        const cajero = unique('cajero');
        const base0 = {
            openedBy: cajero,
            openingAmount: 0,
            expectedCashAmount: 0,
            countedCashAmount: 0,
            cashDifference: 0,
            closedBy: cajero,
            closedAt: Timestamp.now(),
        };
        const revisar = await cashSessionsRepo.createCashSession(base0);
        await db().collection('cashSessions').doc(revisar.id)
            .update({ autoClosed: true, needsReview: true });
        // Autocierre anterior a la marca: también por revisar.
        const legado = await cashSessionsRepo.createCashSession({
            ...base0,
            autoClosedByExpiry: true,
        });
        await cashSessionsRepo.createCashSession(base0);

        const from = minutesAgo(24 * 60).toISOString();
        // Mismos parámetros que arma `CashSessionService.listAudit` del POS.
        const query = new URLSearchParams({
            from,
            openedBy: cajero,
            needsReview: 'true',
            page: '1',
            limit: '100',
        });
        const res = await fetch(`${base}/v1/cash-sessions?${query}`, {
            headers: { Authorization: 'Bearer token-admin' },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as {
            data: Array<{ id: string; needsReview?: boolean }>;
            meta: { total: number };
        };
        expect(body.data.map((item) => item.id).sort()).toEqual([revisar.id, legado.id].sort());
        expect(body.meta.total).toBe(2);

        const invalido = await fetch(
            `${base}/v1/cash-sessions?${new URLSearchParams({ needsReview: 'si' })}`,
            { headers: { Authorization: 'Bearer token-admin' } },
        );
        expect(invalido.status).toBe(400);
    });
});
