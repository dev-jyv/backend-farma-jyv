import { FieldValue } from 'firebase-admin/firestore';
import { SalesController } from '../src/modules/sales/sales.controller';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import { createSaleSchema } from '../src/schemas';
import * as analyticsService from '../src/services/analytics.service';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import { AuthUser } from '../src/types';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 54 (ventas) — una venta sincronizada por otro usuario conserva a quien la
 * cobró (`soldBy` → `cashierId`, quien sube → `syncedBy`) y su llave de
 * idempotencia no depende de quien sincroniza (`<cashSessionId>:<key>`).
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const authUser = (uid: string, slug: string): AuthUser => ({
    uid,
    role: { slug },
    permissions: slug === 'admin'
        ? []
        : [{ area: 'pos', level: 'write' }, { area: 'sales', level: 'read' }],
} as unknown as AuthUser);

let productId: string;

beforeAll(async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsService.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 100,
        minStock: 1,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
    } as Parameters<typeof productsService.createProduct>[0]);
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-01-01'),
        quantity: 500,
        costPrice: 40,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 500 });
    productId = product.id;
});

/** Cajeros distintos por prueba: la base no se limpia entre pruebas del archivo. */
const actors = () => {
    const a = unique('cajera-a');
    const b = unique('cajero-b');
    return {
        a,
        b,
        cashierA: authUser(a, 'cashier'),
        cashierB: authUser(b, 'cashier'),
        admin: authUser(unique('admin'), 'admin'),
    };
};

/** Turno abierto por la vía real, que guarda el rol de quien lo abre. */
const openShift = (uid: string, roleSlug = 'cashier') =>
    cashSessionsService.openSession(uid, 0, { roleSlug });

const offlinePayload = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: unique('llave'),
    items: [{ productId, quantity: 1, unitPrice: 100 }],
    paymentMethod: 'cash',
    amountReceived: 100,
    cashSessionId: sessionId,
    soldAt: new Date().toISOString(),
    ...overrides,
});

const bulk = async (user: AuthUser, items: Record<string, unknown>[]) =>
    (await new SalesController().bulkCreate({ items }, user)).data;

const salesOfSession = async (sessionId: string) =>
    db().collection('sales').where('cashSessionId', '==', sessionId).get();

const auditsOf = async (saleId: string, action: string) =>
    (await db().collection('auditLogs')
        .where('entityId', '==', saleId)
        .where('action', '==', action)
        .get()).docs.map((doc) => doc.data());

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
    const error = await promise.then(
        () => { throw new Error('Se esperaba un rechazo'); },
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
};

describe('SPEC 54 — schema', () => {
    it('acepta soldBy y discountAuthorizedBy opcionales', () => {
        const parsed = createSaleSchema.parse(offlinePayload('cs', {
            soldBy: 'uid-a',
            discountAuthorizedBy: 'uid-admin',
        }));
        expect(parsed.soldBy).toBe('uid-a');
        expect(parsed.discountAuthorizedBy).toBe('uid-admin');
        expect(createSaleSchema.parse(offlinePayload('cs', { soldBy: null })).soldBy)
            .toBeUndefined();
        expect(createSaleSchema.safeParse(offlinePayload('cs', { soldBy: '' })).success)
            .toBe(false);
    });
});

describe('SPEC 54 — autor original al sincronizar', () => {
    it('A cobra, se pierde la respuesta y el admin reenvía con soldBy = A: misma', async () => {
        const { a, cashierA, admin } = actors();
        const session = await openShift(a);
        const payload = offlinePayload(session.id, { soldBy: a });

        const [first] = await bulk(cashierA, [payload]);
        expect(first.ok).toBe(true);
        const [replay] = await bulk(admin, [payload]);
        expect(replay.ok).toBe(true);
        if (first.ok && replay.ok) {
            expect(replay.sale.id).toBe(first.sale.id);
            expect(replay.sale.cashierId).toBe(a);
        }
        expect((await salesOfSession(session.id)).size).toBe(1);

        // La llave es del turno, no de quien sincroniza.
        const keyDoc = await db().collection('saleIdempotencyKeys')
            .doc(`${session.id}:${payload.idempotencyKey}`).get();
        expect(keyDoc.exists).toBe(true);
        expect(keyDoc.data()?.cashierId).toBe(a);
    });

    it('con la llave vieja (<cajero>:<key>) el reintento del admin tampoco duplica', async () => {
        const { a, cashierA, admin } = actors();
        const session = await openShift(a);
        const payload = offlinePayload(session.id, { soldBy: a });
        const [first] = await bulk(cashierA, [payload]);

        // Simula que el primer intento confirmó con el backend anterior a SPEC 54.
        const keys = db().collection('saleIdempotencyKeys');
        const current = keys.doc(`${session.id}:${payload.idempotencyKey}`);
        const data = (await current.get()).data()!;
        await keys.doc(`${a}:${payload.idempotencyKey}`).set(data);
        await current.delete();

        const [byAdmin] = await bulk(admin, [payload]);
        const [byA] = await bulk(cashierA, [payload]);
        expect(first.ok && byAdmin.ok && byA.ok).toBe(true);
        if (first.ok && byAdmin.ok && byA.ok) {
            expect(byAdmin.sale.id).toBe(first.sale.id);
            expect(byA.sale.id).toBe(first.sale.id);
        }
        expect((await salesOfSession(session.id)).size).toBe(1);
    });

    it('B sube una venta de A con soldBy = A: cashierId = A, syncedBy = B', async () => {
        const { a, b, cashierB } = actors();
        const session = await openShift(a);
        const [result] = await bulk(cashierB, [offlinePayload(session.id, { soldBy: a })]);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.sale.cashierId).toBe(a);
        expect(result.sale.syncedBy).toBe(b);

        const stored = await salesRepo.getSaleById(result.sale.id);
        expect(stored?.cashierId).toBe(a);
        expect(stored?.syncedBy).toBe(b);

        const movements = await db().collection('stockMovements')
            .where('referenceId', '==', result.sale.id).get();
        expect(movements.docs.every((doc) => doc.data().userId === a)).toBe(true);

        const audits = await auditsOf(result.sale.id, 'sale.synced_by_other');
        expect(audits).toHaveLength(1);
        expect(audits[0].userId).toBe(b);
        expect(audits[0].metadata).toMatchObject({ cashierId: a, syncedBy: b });

        // El reporte por cajero atribuye la venta a A.
        const window = {
            from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
        const report = await analyticsService.getSalesByCashier(window);
        const ids = report.items.map((item) => item.cashierId);
        expect(ids).toContain(a);
        expect(ids).not.toContain(b);
    });

    it('A sube lo suyo con soldBy = A: sin syncedBy ni auditoría', async () => {
        const { a, cashierA } = actors();
        const session = await openShift(a);
        const [result] = await bulk(cashierA, [offlinePayload(session.id, { soldBy: a })]);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.sale.cashierId).toBe(a);
            expect(result.sale).not.toHaveProperty('syncedBy');
            expect(await auditsOf(result.sale.id, 'sale.synced_by_other')).toHaveLength(0);
        }
    });

    it('sin soldBy (POS viejo), B sigue sin poder subir al turno de A', async () => {
        const { a, cashierB } = actors();
        const session = await openShift(a);
        const [result] = await bulk(cashierB, [offlinePayload(session.id)]);
        expect(result).toMatchObject({ ok: false, code: 'SESSION_FORBIDDEN' });
        expect((await salesOfSession(session.id)).size).toBe(0);
    });

    it('soldBy que no abrió el turno se ignora: B no entra, el admin queda de autor', async () => {
        const { a, b, cashierB, admin } = actors();
        const session = await openShift(a);
        const [byB] = await bulk(cashierB, [offlinePayload(session.id, { soldBy: b })]);
        expect(byB).toMatchObject({ ok: false, code: 'SESSION_FORBIDDEN' });

        const intruder = unique('otro');
        const [byAdmin] = await bulk(admin, [offlinePayload(session.id, { soldBy: intruder })]);
        expect(byAdmin.ok).toBe(true);
        if (!byAdmin.ok) {
            return;
        }
        expect(byAdmin.sale.cashierId).toBe(admin.uid);
        expect(byAdmin.sale).not.toHaveProperty('syncedBy');
        const audits = await auditsOf(byAdmin.sale.id, 'sale.sold_by_ignored');
        expect(audits).toHaveLength(1);
        expect(audits[0].metadata).toMatchObject({ soldBy: intruder, sessionOpenedBy: a });
    });

    it('en línea (POST /sales) soldBy no cuenta', async () => {
        const { a, cashierB } = actors();
        const session = await openShift(a);
        const error = await rejection(new SalesController().create(
            createSaleSchema.parse(offlinePayload(session.id, { soldBy: a })),
            cashierB,
        ));
        expect(error.statusCode).toBe(403);
    });

    it('sin pos:write quien llama, soldBy no cuenta', async () => {
        const { a, b } = actors();
        const session = await openShift(a);
        const error = await rejection(salesService.createSale({
            ...createSaleSchema.parse(offlinePayload(session.id, { soldBy: a })),
            cashierId: b,
            roleSlug: 'manager-sin-caja',
            offline: true,
            callerHasPosWrite: false,
        }));
        expect(error.syncCode).toBe('SESSION_FORBIDDEN');
    });

    it('la llave de otro turno no devuelve una venta ajena', async () => {
        const { a, cashierA, cashierB } = actors();
        const session = await openShift(a);
        const payload = offlinePayload(session.id);
        const [first] = await bulk(cashierA, [payload]);
        expect(first.ok).toBe(true);
        const [byB] = await bulk(cashierB, [payload]);
        expect(byB).toMatchObject({ ok: false, code: 'SESSION_FORBIDDEN' });
    });
});

describe('SPEC 54 — tope de descuento con el rol de quien cobró', () => {
    // 30 % sobre 100: arriba del tope del 20 % para un no-admin.
    const discounted = (sessionId: string, soldBy: string) => offlinePayload(sessionId, {
        soldBy,
        items: [{ productId, quantity: 1, unitPrice: 100, discountAmount: 30 }],
        amountReceived: 70,
        discountAuthorizedBy: 'uid-gerente',
    });

    it('el admin que sube la venta de una cajera no salta el tope de ella', async () => {
        const { a, admin } = actors();
        const session = await openShift(a, 'cashier');
        const [result] = await bulk(admin, [discounted(session.id, a)]);
        expect(result).toMatchObject({ ok: false });
        if (!result.ok) {
            expect(result.error).toContain('Solo un administrador');
        }
    });

    it('turno anterior sin rol guardado: se usa el rol de quien llama', async () => {
        const { a, admin } = actors();
        const session = await openShift(a);
        await db().collection('cashSessions').doc(session.id)
            .update({ openedByRoleSlug: FieldValue.delete() });
        const [result] = await bulk(admin, [discounted(session.id, a)]);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.sale.cashierId).toBe(a);
        expect(result.sale.discountAuthorizedBy).toBe('uid-gerente');
        expect((await salesRepo.getSaleById(result.sale.id))?.discountAuthorizedBy)
            .toBe('uid-gerente');
        const overrides = await auditsOf(result.sale.id, 'sale.discount_override');
        expect(overrides[0].metadata).toMatchObject({
            cashierId: a,
            discountAuthorizedBy: 'uid-gerente',
        });
    });

    it('turno de un admin: su venta subida por un cajero usa el rol del admin', async () => {
        const { cashierB, admin } = actors();
        const session = await openShift(admin.uid, 'admin');
        const [result] = await bulk(cashierB, [discounted(session.id, admin.uid)]);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.sale.cashierId).toBe(admin.uid);
        }
    });
});
