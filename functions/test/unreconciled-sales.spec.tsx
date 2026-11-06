import 'reflect-metadata';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactElement } from 'react';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as usersRepo from '../src/repositories/users.repository';
import * as productsService from '../src/services/products.service';
import * as unreconciledService from '../src/services/unreconciled-sales.service';
import * as salesService from '../src/services/sales.service';
import { buildDailyReport } from '../src/services/sales-reports.service';
import { sendReportEmail } from '../src/services/email.service';
import { SalesReportEmail } from '../src/emails/sales-report.email';
import {
    createUnreconciledSaleSchema,
    resolveUnreconciledSaleSchema,
} from '../src/schemas';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { SalesController } from '../src/modules/sales/sales.controller';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';
import { APP_TIME_ZONE, getZonedYmd } from '../src/utils/timezone';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

const enviar = sendReportEmail as jest.MockedFunction<typeof sendReportEmail>;

/**
 * SPEC 53 — ventas no conciliadas visibles y resolubles (parte backend):
 *
 * - id `<deviceId|cashierId>:<localId>` escrito con `create`: un reenvío no
 *   cambia `createdAt`, no reabre una resuelta y no repite bitácora ni correo;
 * - `POST /sales/unreconciled/:id/resolve` registra (createSale offline con el
 *   payload guardado) o descarta con motivo, auditado y solo con `sales:write`;
 * - correo de alerta al darla de alta, sin poder tumbar la respuesta;
 * - conteo y monto de las pendientes en el correo diario.
 *
 * Resend está simulado: se afirma qué se mandó, no la entrega.
 */

const CAJERO = 'cajero-1';
const GERENTE = { userId: 'gerente-1', roleSlug: 'manager' };
const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const hoy = (): string => getZonedYmd(Date.now(), APP_TIME_ZONE);

let categoryId: string;

beforeAll(async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    categoryId = category.id;
    await usersRepo.createUserProfile(CAJERO, {
        email: 'cajero@farmajyv.mx',
        displayName: 'Ana Cajera',
        roleId: 'r-cashier',
        isActive: true,
    } as Parameters<typeof usersRepo.createUserProfile>[1]);
});

beforeEach(() => {
    enviar.mockReset();
    enviar.mockResolvedValue(undefined);
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

const abrirTurno = () => cashSessionsRepo.createCashSession({
    openedBy: CAJERO,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const payloadDeVenta = (productId: string, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: unique('llave-venta'),
    items: [{ productId, quantity: 2, unitPrice: 50 }],
    paymentMethod: 'cash',
    amountReceived: 100,
    ...extra,
});

const alta = (overrides: Partial<Parameters<typeof unreconciledService.recordUnreconciledSale>[0]> =
{}) => unreconciledService.recordUnreconciledSale({
    localId: unique('local'),
    reason: 'Producto no encontrado en el servidor',
    total: 100,
    payload: { items: [] },
    cashierId: CAJERO,
    roleSlug: 'cashier',
    ...overrides,
});

const auditorias = async (entityId: string, action: string) => {
    const snapshot = await db().collection('auditLogs')
        .where('entityId', '==', entityId)
        .get();
    return snapshot.docs.filter((doc) => doc.get('action') === action);
};

const expectAppError = async (promise: Promise<unknown>, status: number, message?: string) => {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(status);
    if (message) {
        expect((error as AppError).message).toContain(message);
    }
    return error as AppError;
};

describe('esquemas (SPEC 53)', () => {
    const base = {
        localId: 'local-1',
        reason: 'Producto no encontrado',
        total: 100,
        payload: {},
    };

    it('un localId con "/" responde 400, no 500', () => {
        const pipe = new ZodValidationPipe(createUnreconciledSaleSchema);
        let error: unknown;
        try {
            pipe.transform({ ...base, localId: 'ventas/1' });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
        expect((error as AppError).message).toContain('localId');
    });

    it('localId: solo [A-Za-z0-9_-], de 1 a 128', () => {
        const ok = (localId: string) =>
            createUnreconciledSaleSchema.safeParse({ ...base, localId }).success;
        expect(ok('abc_DEF-123')).toBe(true);
        expect(ok('a'.repeat(128))).toBe(true);
        expect(ok('a'.repeat(129))).toBe(false);
        expect(ok('')).toBe(false);
        expect(ok('con espacio')).toBe(false);
        expect(ok('a:b')).toBe(false);
        expect(ok('__x__.')).toBe(false);
    });

    it('deviceId es opcional y tampoco admite "/"', () => {
        expect(createUnreconciledSaleSchema.safeParse(base).success).toBe(true);
        expect(createUnreconciledSaleSchema.safeParse({ ...base, deviceId: 'caja-01' }).success)
            .toBe(true);
        expect(createUnreconciledSaleSchema.safeParse({ ...base, deviceId: 'a/b' }).success)
            .toBe(false);
    });

    it('descartar exige un motivo de 5 caracteres o más; registrar no', () => {
        const parse = (body: unknown) => resolveUnreconciledSaleSchema.safeParse(body);
        expect(parse({ action: 'discard', reason: 'abcd' }).success).toBe(false);
        expect(parse({ action: 'discard', reason: '   abcd   ' }).success).toBe(false);
        expect(parse({ action: 'discard' }).success).toBe(false);
        expect(parse({ action: 'discard', reason: 'Venta duplicada' }).success).toBe(true);
        expect(parse({ action: 'register' }).success).toBe(true);
        expect(parse({ action: 'otra', reason: 'Venta duplicada' }).success).toBe(false);
    });

    it('resolver exige sales:write (admin y gerente; el cajero solo lee)', () => {
        const meta = Reflect.getMetadata(
            PERMISSION_KEY,
            SalesController.prototype.resolveUnreconciled,
        );
        expect(meta).toEqual({ area: 'sales', level: 'write' });
        const lista = Reflect.getMetadata(
            PERMISSION_KEY,
            SalesController.prototype.listUnreconciled,
        );
        expect(lista).toEqual({ area: 'sales', level: 'read' });
    });
});

describe('alta idempotente (SPEC 53)', () => {
    it('el id es <deviceId>:<localId>, o <cashierId>:<localId> sin caja', async () => {
        const conCaja = await alta({ localId: 'v-1', deviceId: 'caja-01' });
        expect(conCaja.id).toBe('caja-01:v-1');
        expect(conCaja.deviceId).toBe('caja-01');

        const sinCaja = await alta({ localId: 'v-1' });
        expect(sinCaja.id).toBe(`${CAJERO}:v-1`);
        expect(sinCaja.deviceId).toBeNull();
    });

    it('reenviar la misma no cambia createdAt ni repite bitácora ni correo', async () => {
        const primera = await alta({ localId: 'v-reenvio', deviceId: 'caja-02' });
        const segunda = await alta({
            localId: 'v-reenvio',
            deviceId: 'caja-02',
            reason: 'otro motivo',
        });

        expect(segunda.id).toBe(primera.id);
        expect(segunda.createdAt.toMillis()).toBe(primera.createdAt.toMillis());
        expect(segunda.reason).toBe(primera.reason);
        expect(await auditorias(primera.id, 'sale.unreconciled')).toHaveLength(1);
        expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('reenviar una ya resuelta no la reabre', async () => {
        const venta = await alta({ localId: 'v-resuelta', deviceId: 'caja-03' });
        await unreconciledService.resolveUnreconciledSale(
            venta.id,
            { action: 'discard', reason: 'Duplicada del ticket 4' },
            GERENTE,
        );

        const reenvio = await alta({ localId: 'v-resuelta', deviceId: 'caja-03' });
        expect(reenvio.resolvedAt).not.toBeNull();
        expect(reenvio.resolution).toBe('discard');
        const doc = await db().collection('unreconciledSales').doc(venta.id).get();
        expect(doc.get('resolvedAt')).not.toBeNull();
        expect(doc.get('createdAt').toMillis()).toBe(venta.createdAt.toMillis());
    });

    it('dos cajas con el mismo localId no se pisan', async () => {
        const a = await alta({ localId: 'v-comun', deviceId: 'caja-a', total: 10 });
        const b = await alta({ localId: 'v-comun', deviceId: 'caja-b', total: 20 });
        expect(a.id).not.toBe(b.id);
        expect((await db().collection('unreconciledSales').doc(b.id).get()).get('total'))
            .toBe(20);
    });

    it('un reintento de una subida antes de SPEC 53 (id = localId) no la duplica', async () => {
        await db().collection('unreconciledSales').doc('v-vieja').set({
            localId: 'v-vieja',
            localFolio: null,
            reason: 'Stock insuficiente',
            total: 75,
            payload: {},
            cashierId: CAJERO,
            cashSessionId: null,
            occurredAt: null,
            resolvedAt: null,
            resolvedBy: null,
            createdAt: toTimestamp('2026-11-01T12:00:00.000Z'),
        });

        const reenvio = await alta({ localId: 'v-vieja', deviceId: 'caja-01' });
        expect(reenvio.id).toBe('v-vieja');
        expect((await db().collection('unreconciledSales').doc('caja-01:v-vieja').get()).exists)
            .toBe(false);
        expect(enviar).not.toHaveBeenCalled();
    });

    it('las viejas sin prefijo se listan y se resuelven igual', async () => {
        await db().collection('unreconciledSales').doc('v-legado').set({
            localId: 'v-legado',
            localFolio: 'PENDIENTE-1',
            reason: 'Stock insuficiente',
            total: 40,
            payload: {},
            cashierId: CAJERO,
            cashSessionId: null,
            occurredAt: null,
            resolvedAt: null,
            resolvedBy: null,
            createdAt: toTimestamp(new Date().toISOString()),
        });

        const { items } = await unreconciledService.listUnreconciledSales({});
        const fila = items.find((item) => item.id === 'v-legado');
        expect(fila).toMatchObject({
            deviceId: null,
            resolution: null,
            cashierName: 'Ana Cajera',
        });

        const { unreconciled } = await unreconciledService.resolveUnreconciledSale(
            'v-legado',
            { action: 'discard', reason: 'Se cobró dos veces' },
            GERENTE,
        );
        expect(unreconciled.resolution).toBe('discard');
        expect(unreconciled.resolutionReason).toBe('Se cobró dos veces');
    });

    it('el listado trae el nombre de la caja desde su diagnóstico', async () => {
        await db().collection('posDiagnostics').doc('caja-nombrada').set({
            deviceName: 'MOSTRADOR-1',
        });
        const venta = await alta({ deviceId: 'caja-nombrada' });
        const { items } = await unreconciledService.listUnreconciledSales({});
        expect(items.find((item) => item.id === venta.id)?.deviceName).toBe('MOSTRADOR-1');
    });
});

describe('correo de alerta (SPEC 53)', () => {
    it('asunto "Venta no conciliada: <monto> en <caja>" con el nombre de la caja', async () => {
        await db().collection('posDiagnostics').doc('caja-correo').set({
            deviceName: 'MOSTRADOR-2',
        });
        await alta({
            deviceId: 'caja-correo',
            total: 1234.5,
            localFolio: 'PENDIENTE-99',
            reason: 'Producto abc no encontrado',
        });

        expect(enviar).toHaveBeenCalledTimes(1);
        const [{ subject, react }] = enviar.mock.calls[0];
        expect(subject).toBe('Venta no conciliada: $1,234.50 en MOSTRADOR-2');
        const html = renderToStaticMarkup(react as ReactElement);
        expect(html).toContain('Ana Cajera');
        expect(html).toContain('PENDIENTE-99');
        expect(html).toContain('Producto abc no encontrado');
    });

    it('sin caja, cita la caja del cajero', async () => {
        await alta({ total: 10 });
        expect(enviar.mock.calls[0][0].subject)
            .toBe('Venta no conciliada: $10.00 en la caja de Ana Cajera');
    });

    it('Resend caído: el alta responde igual y la venta queda guardada', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            enviar.mockRejectedValue(new Error('Resend 503'));
            const venta = await alta({ deviceId: 'caja-caida' });
            expect((await db().collection('unreconciledSales').doc(venta.id).get()).exists)
                .toBe(true);
            expect(error).toHaveBeenCalledWith(
                'No se pudo mandar la alerta de venta no conciliada',
                expect.objectContaining({ id: venta.id, error: 'Resend 503' }),
            );
        } finally {
            error.mockRestore();
        }
    });

    it('un envío lento no retiene el alta más allá del tope de 5 s', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            enviar.mockImplementation(() => new Promise(() => undefined));
            const respuesta = alta({ deviceId: 'caja-lenta' });
            while (enviar.mock.calls.length === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            jest.advanceTimersByTime(unreconciledService.UNRECONCILED_SALE_ALERT_TIMEOUT_MS);
            await expect(respuesta).resolves.toMatchObject({ deviceId: 'caja-lenta' });
            expect(unreconciledService.UNRECONCILED_SALE_ALERT_TIMEOUT_MS).toBe(5_000);
        } finally {
            jest.useRealTimers();
            warn.mockRestore();
        }
    });
});

describe('resolver: registrar como venta (SPEC 53)', () => {
    it('crea la venta offline, guarda resolvedSaleId y la auditoría', async () => {
        const product = await crearProducto();
        const turno = await abrirTurno();
        const pendiente = await alta({
            deviceId: 'caja-reg',
            total: 100,
            cashSessionId: turno.id,
            payload: payloadDeVenta(product.id, { cashSessionId: turno.id }),
        });

        const { unreconciled, sale } = await unreconciledService.resolveUnreconciledSale(
            pendiente.id,
            { action: 'register' },
            GERENTE,
        );

        expect(sale).toBeDefined();
        expect(sale!.total).toBe(100);
        expect(sale!.cashierId).toBe(CAJERO);
        expect(sale!.cashSessionId).toBe(turno.id);
        expect(unreconciled.resolution).toBe('register');
        expect(unreconciled.resolvedSaleId).toBe(sale!.id);
        expect(unreconciled.resolvedBy).toBe(GERENTE.userId);

        const doc = await db().collection('unreconciledSales').doc(pendiente.id).get();
        expect(doc.get('resolvedSaleId')).toBe(sale!.id);
        expect(doc.get('resolvedAt')).not.toBeNull();

        const audit = await auditorias(pendiente.id, 'sale.unreconciled_resolved');
        expect(audit).toHaveLength(1);
        expect(audit[0].get('metadata')).toMatchObject({
            action: 'register',
            resolvedSaleId: sale!.id,
        });

        const stock = await productsRepo.getProductById(product.id);
        expect(stock?.totalStock).toBe(8);
    });

    it('doble clic en Registrar no duplica la venta', async () => {
        const product = await crearProducto();
        const turno = await abrirTurno();
        const pendiente = await alta({
            payload: payloadDeVenta(product.id, { cashSessionId: turno.id }),
        });

        const [a, b] = await Promise.all([
            unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            ),
            unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            ),
        ]);
        expect(a.sale?.id).toBeDefined();
        expect(b.sale?.id).toBe(a.sale?.id);

        const ventas = await db().collection('sales').where('cashierId', '==', CAJERO).get();
        expect(ventas.docs.filter((doc) =>
            doc.get('items')?.[0]?.productId === product.id)).toHaveLength(1);
        expect(await auditorias(pendiente.id, 'sale.unreconciled_resolved')).toHaveLength(1);

        // Un tercer clic, ya resuelta, devuelve la misma venta.
        const tercero = await unreconciledService.resolveUnreconciledSale(
            pendiente.id, { action: 'register' }, GERENTE,
        );
        expect(tercero.sale?.id).toBe(a.sale?.id);
        expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(8);
    });

    it('sin turno en el payload ni en el documento, la venta entra sin turno', async () => {
        const product = await crearProducto();
        const pendiente = await alta({ payload: payloadDeVenta(product.id) });

        const { sale } = await unreconciledService.resolveUnreconciledSale(
            pendiente.id, { action: 'register' }, GERENTE,
        );
        expect(sale?.cashSessionId).toBeNull();
        const doc = await db().collection('sales').doc(sale!.id).get();
        expect(doc.get('cashSessionId')).toBeNull();
    });

    it('un producto que sigue sin existir responde 400 y la venta sigue pendiente', async () => {
        const turno = await abrirTurno();
        const pendiente = await alta({
            payload: payloadDeVenta('producto-inexistente', { cashSessionId: turno.id }),
        });

        await expectAppError(
            unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            ),
            400,
            'producto-inexistente',
        );
        const doc = await db().collection('unreconciledSales').doc(pendiente.id).get();
        expect(doc.get('resolvedAt')).toBeNull();
        expect(await auditorias(pendiente.id, 'sale.unreconciled_resolved')).toHaveLength(0);
    });

    /**
     * Caja real, 06/11: el turno del 05/11 13:56 se creó **y cerró** en el
     * servidor al sincronizar al día siguiente (el POS no manda su hora de
     * apertura). Sus 21 ventas tenían `soldAt` anterior a ese `openedAt`, se
     * tomaban como "antes de la apertura", la fecha de negocio pasaba a ser la de
     * recepción —posterior al cierre— y "Registrar" las rechazaba otra vez con
     * "El turno de caja ya está cerrado".
     */
    describe('turno creado en el servidor después de la venta', () => {
        const turnoCreadoTarde = async () => {
            const turno = await abrirTurno();
            // Abierto y cerrado en el mismo instante, como lo deja el POS.
            await db().collection('cashSessions').doc(turno.id)
                .update({ closedAt: turno.openedAt });
            return turno;
        };
        const ayer = () => new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();

        it('Registrar respeta la hora de cobro y la mete al turno como lateSync', async () => {
            const product = await crearProducto();
            const turno = await turnoCreadoTarde();
            const soldAt = ayer();
            const pendiente = await alta({
                cashSessionId: turno.id,
                payload: payloadDeVenta(product.id, { cashSessionId: turno.id, soldAt }),
            });

            const { sale } = await unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            );

            expect(sale?.cashSessionId).toBe(turno.id);
            expect(sale?.lateSync).toBe(true);
            expect(sale?.businessAt?.toDate().toISOString()).toBe(soldAt);
            expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(8);

            const [audit] = await auditorias(pendiente.id, 'sale.unreconciled_resolved');
            expect(audit.get('metadata')).toMatchObject({ saleBusinessAt: soldAt, lateSync: true });
            expect(await auditorias(sale!.id, 'sale.sold_at_untrusted')).toHaveLength(0);
        });

        it('sin pasar por Registrar, la misma venta offline sigue rechazada', async () => {
            const product = await crearProducto();
            const turno = await turnoCreadoTarde();

            await expectAppError(
                salesService.createSale({
                    ...payloadDeVenta(product.id),
                    cashSessionId: turno.id,
                    soldAt: ayer(),
                    cashierId: CAJERO,
                    roleSlug: 'cashier',
                    offline: true,
                } as Parameters<typeof salesService.createSale>[0]),
                400,
                'El turno de caja ya está cerrado',
            );
        });

        it('una hora de cobro posterior al cierre sigue rechazada aunque se autorice', async () => {
            const product = await crearProducto();
            const turno = await turnoCreadoTarde();
            const pendiente = await alta({
                cashSessionId: turno.id,
                payload: payloadDeVenta(product.id, {
                    cashSessionId: turno.id,
                    soldAt: new Date(Date.now() + 60 * 1000).toISOString(),
                }),
            });

            await expectAppError(
                unreconciledService.resolveUnreconciledSale(
                    pendiente.id, { action: 'register' }, GERENTE,
                ),
                400,
                'El turno de caja ya está cerrado',
            );
            const doc = await db().collection('unreconciledSales').doc(pendiente.id).get();
            expect(doc.get('resolvedAt')).toBeNull();
        });
    });

    it('un payload irrecuperable responde 400 con el motivo', async () => {
        const pendiente = await alta({ payload: { basura: true } });
        await expectAppError(
            unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            ),
            400,
            'no se puede registrar tal cual',
        );
    });

    it('una id que no existe es 404', async () => {
        await expectAppError(
            unreconciledService.resolveUnreconciledSale(
                'caja:nada', { action: 'register' }, GERENTE,
            ),
            404,
        );
    });
});

describe('resolver: descartar (SPEC 53)', () => {
    it('la marca con el motivo y lo audita', async () => {
        const pendiente = await alta({ total: 55 });
        const { unreconciled, sale } = await unreconciledService.resolveUnreconciledSale(
            pendiente.id,
            { action: 'discard', reason: '  Prueba de capacitación  ' },
            GERENTE,
        );
        expect(sale).toBeUndefined();
        expect(unreconciled).toMatchObject({
            resolution: 'discard',
            resolutionReason: 'Prueba de capacitación',
            resolvedSaleId: null,
            resolvedBy: GERENTE.userId,
        });
        const audit = await auditorias(pendiente.id, 'sale.unreconciled_resolved');
        expect(audit).toHaveLength(1);
        expect(audit[0].get('metadata')).toMatchObject({
            action: 'discard',
            reason: 'Prueba de capacitación',
        });
    });

    it('registrar una descartada es 409, y repetir el descarte no duplica', async () => {
        const pendiente = await alta();
        await unreconciledService.resolveUnreconciledSale(
            pendiente.id, { action: 'discard', reason: 'Venta de prueba' }, GERENTE,
        );
        await expectAppError(
            unreconciledService.resolveUnreconciledSale(
                pendiente.id, { action: 'register' }, GERENTE,
            ),
            409,
            'descartada',
        );
        await unreconciledService.resolveUnreconciledSale(
            pendiente.id, { action: 'discard', reason: 'Venta de prueba' }, GERENTE,
        );
        expect(await auditorias(pendiente.id, 'sale.unreconciled_resolved')).toHaveLength(1);
    });
});

describe('correo diario: pendientes (SPEC 53)', () => {
    it('suma conteo y monto de las pendientes de cualquier fecha, no las resueltas', async () => {
        const antes = await buildDailyReport(hoy());

        await alta({ total: 100.1 });
        await alta({ total: 0.2 });
        const resuelta = await alta({ total: 999 });
        await unreconciledService.resolveUnreconciledSale(
            resuelta.id, { action: 'discard', reason: 'Venta de prueba' }, GERENTE,
        );
        await db().collection('unreconciledSales').doc('v-antigua').set({
            localId: 'v-antigua',
            reason: 'Stock',
            total: 50,
            payload: {},
            cashierId: CAJERO,
            cashSessionId: null,
            occurredAt: null,
            resolvedAt: null,
            resolvedBy: null,
            createdAt: toTimestamp('2026-01-01T12:00:00.000Z'),
        });

        const despues = await buildDailyReport(hoy());
        expect(despues.unreconciledPending.count - antes.unreconciledPending.count).toBe(3);
        expect(despues.unreconciledPending.total - antes.unreconciledPending.total)
            .toBeCloseTo(150.3, 2);

        const html = renderToStaticMarkup(SalesReportEmail({ report: despues }));
        expect(html).toContain(`Ventas no conciliadas pendientes (${
            despues.unreconciledPending.count})`);
        expect(html).toContain('Ventas no conciliadas');
    });

    it('sin pendientes no aparece la sección', async () => {
        const reporte = await buildDailyReport(hoy());
        const html = renderToStaticMarkup(SalesReportEmail({
            report: { ...reporte, unreconciledPending: { count: 0, total: 0 } },
        }));
        expect(html).not.toContain('Ventas no conciliadas pendientes');
    });
});
