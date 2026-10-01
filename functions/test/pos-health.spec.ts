import * as posHealthService from '../src/services/pos-health.service';
import { evaluateBlockedSalesAlert } from '../src/services/pos-health-alerts.service';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import {
    POS_DIAGNOSTICS_LIMITS,
    POS_TEXT_MAX,
    createPosCommandSchema,
    posCommandResultSchema,
    posDiagnosticsSchema,
} from '../src/schemas';
import { PosDiagnosticsInput } from '../src/types';
import { AppError } from '../src/utils/errors';
import { db } from '../src/utils/firestore';

/**
 * Salud de cajas contra el emulador: el diagnóstico se sobrescribe por caja, los
 * comandos se entregan en la respuesta del reporte y el resultado es idempotente.
 * Los permisos por ruta están en `pos-health-permissions.spec.ts`.
 */

const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };
const CAJERO = 'cashier-user';

const venta = (localId: string) => ({
    localId,
    folio: `F-${localId}`,
    total: 120.5,
    createdAt: '2026-10-01T10:00:00.000Z',
    cashSessionId: 'turno-local-1',
    pushError: 'Turno sin remoteId',
    waitingFor: 'turno' as const,
    blockers: [{
        kind: 'cashSession' as const,
        localId: 'turno-local-1',
        remoteId: null,
        label: 'Turno de Ana',
        error: null,
        missingLocally: false,
    }],
});

const diagnostico = (overrides: Partial<PosDiagnosticsInput> = {}): PosDiagnosticsInput => ({
    deviceId: 'caja-01',
    deviceName: 'MOSTRADOR-1',
    appVersion: '1.0.5',
    platform: 'win32',
    generatedAt: '2026-10-01T10:05:00.000Z',
    pendingSalesCount: 1,
    blockedSales: [venta('v1')],
    blockedCashSessions: [],
    unsyncedProducts: [],
    recentSyncRuns: [],
    syncLog: [],
    ...overrides,
});

/**
 * El teardown global limpia la base por archivo, no por caso; aquí cada caso
 * cuenta documentos y comandos pendientes, así que se parte de cero.
 */
beforeEach(async () => {
    for (const name of ['posDiagnostics', 'posCommands', 'auditLogs']) {
        await db().recursiveDelete(db().collection(name));
    }
});

/** Atajos para que cada caso diga qué pide y no cómo se llama al service. */
const terminar = (id: string, status: 'done' | 'failed', message: string | null = null) =>
    posHealthService.completeCommand(id, { status, message }, CAJERO);

const capturar = async (promesa: Promise<unknown>): Promise<AppError> => {
    try {
        await promesa;
    } catch (error) {
        return error as AppError;
    }
    throw new Error('debía lanzar');
};

describe('posDiagnosticsSchema', () => {
    it('acepta el contrato completo', () => {
        expect(posDiagnosticsSchema.safeParse(diagnostico()).success).toBe(true);
    });

    it('recorta textos largos en vez de rechazar el reporte', () => {
        const largo = 'x'.repeat(5000);
        const parsed = posDiagnosticsSchema.parse(diagnostico({
            blockedSales: [{ ...venta('v1'), pushError: largo }],
            syncLog: [{ at: 'ahora', level: 'error', entity: 'sale', message: largo, ref: null }],
        }));
        expect(parsed.blockedSales[0].pushError).toHaveLength(POS_TEXT_MAX);
        expect(parsed.syncLog[0].message).toHaveLength(POS_TEXT_MAX);
    });

    it('recorta las listas al máximo pactado', () => {
        const ventas = Array.from({ length: 250 }, (_, i) => venta(`v${i}`));
        const parsed = posDiagnosticsSchema.parse(diagnostico({ blockedSales: ventas }));
        expect(parsed.blockedSales).toHaveLength(POS_DIAGNOSTICS_LIMITS.blockedSales);
        expect(parsed.blockedSales[0].localId).toBe('v0');
    });

    it('normaliza los opcionales ausentes a null', () => {
        const parsed = posDiagnosticsSchema.parse(diagnostico({
            unsyncedProducts: [{ localId: 'p1', name: 'Aspirina' } as never],
        }));
        expect(parsed.unsyncedProducts[0]).toEqual({
            localId: 'p1',
            name: 'Aspirina',
            pushError: null,
            catalogPushError: null,
        });
    });

    it.each([
        ['vacío', ''],
        ['con diagonal', 'caja/01'],
        ['reservado', '__caja__'],
        ['demasiado largo', 'x'.repeat(129)],
    ])('rechaza un deviceId %s', (_caso, deviceId) => {
        expect(posDiagnosticsSchema.safeParse(diagnostico({ deviceId })).success).toBe(false);
    });

    it('rechaza enums fuera del contrato', () => {
        const malo = diagnostico({ syncLog: [{
            at: 'x', level: 'debug' as never, entity: 'sale', message: 'm', ref: null,
        }] });
        expect(posDiagnosticsSchema.safeParse(malo).success).toBe(false);
    });
});

describe('createPosCommandSchema / posCommandResultSchema', () => {
    it('rechaza un tipo de comando desconocido', () => {
        expect(createPosCommandSchema.safeParse({
            deviceId: 'caja-01', type: 'deleteSale', targetLocalId: 'v1',
        }).success).toBe(false);
    });

    it('nota vacía o ausente queda en null', () => {
        expect(createPosCommandSchema.parse({
            deviceId: 'caja-01', type: 'retrySale', targetLocalId: 'v1', note: '  ',
        }).note).toBeNull();
    });

    it('el resultado solo admite done/failed y recorta el mensaje', () => {
        expect(posCommandResultSchema.safeParse({ status: 'pending' }).success).toBe(false);
        const parsed = posCommandResultSchema.parse({ status: 'failed', message: 'e'.repeat(900) });
        expect(parsed.message).toHaveLength(POS_TEXT_MAX);
    });
});

describe('reportDiagnostics', () => {
    it('guarda el snapshot con receivedAt del servidor y reportedBy', async () => {
        const antes = Date.now();
        const result = await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        expect(result).toEqual({ commands: [] });

        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('reportedBy')).toBe(CAJERO);
        expect(doc.get('receivedAt').toMillis()).toBeGreaterThanOrEqual(antes - 1000);
        expect(doc.get('blockedSales')).toHaveLength(1);
    });

    it('sobrescribe el snapshot: lo que la caja ya no reporta desaparece', async () => {
        await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        await posHealthService.reportDiagnostics(diagnostico({ blockedSales: [] }), CAJERO);

        const { snapshot } = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(snapshot.blockedSales).toEqual([]);
    });

    it('devuelve los comandos pendientes de esa caja, el más viejo primero', async () => {
        await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        await posHealthService.reportDiagnostics(diagnostico({ deviceId: 'caja-02' }), CAJERO);

        const primero = await posHealthService.createCommand(
            { deviceId: 'caja-01', type: 'retrySale', targetLocalId: 'v1', note: null }, ADMIN,
        );
        const segundo = await posHealthService.createCommand(
            {
                deviceId: 'caja-01',
                type: 'retryCashSession',
                targetLocalId: 't1',
                note: 'ya abrió',
            },
            ADMIN,
        );
        await posHealthService.createCommand(
            { deviceId: 'caja-02', type: 'retryProduct', targetLocalId: 'p1', note: null }, ADMIN,
        );
        const terminado = await posHealthService.createCommand(
            { deviceId: 'caja-01', type: 'retryProduct', targetLocalId: 'p9', note: null }, ADMIN,
        );
        await terminar(terminado.id, 'done');

        const { commands } = await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        expect(commands.map((command) => command.id)).toEqual([primero.id, segundo.id]);
        expect(commands[1]).toMatchObject({
            deviceId: 'caja-01',
            type: 'retryCashSession',
            targetLocalId: 't1',
            note: 'ya abrió',
            status: 'pending',
            createdBy: ADMIN.userId,
            completedAt: null,
            result: null,
        });
        expect(new Date(commands[0].createdAt).toISOString()).toBe(commands[0].createdAt);
    });
});

describe('fitDiagnosticsToDocument', () => {
    it('no toca un diagnóstico que cabe', () => {
        const input = diagnostico();
        expect(posHealthService.fitDiagnosticsToDocument(input)).toBe(input);
    });

    it('recorta primero la bitácora y deja las ventas bloqueadas', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const input = diagnostico({
            syncLog: Array.from({ length: 200 }, (_, i) => ({
                at: 'x',
                level: 'info' as const,
                entity: 'sale',
                message: 'm'.repeat(400),
                ref: `${i}`,
            })),
        });
        const fitted = posHealthService.fitDiagnosticsToDocument(input, 20_000);
        expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(20_000);
        expect(fitted.syncLog.length).toBeLessThan(200);
        expect(fitted.blockedSales).toHaveLength(1);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('listDiagnostics / getDeviceDiagnostics', () => {
    it('lista las cajas por receivedAt desc con sus pendientes', async () => {
        await posHealthService.reportDiagnostics(diagnostico({ deviceId: 'caja-vieja' }), CAJERO);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await posHealthService.reportDiagnostics(diagnostico({ deviceId: 'caja-nueva' }), CAJERO);
        await posHealthService.createCommand(
            { deviceId: 'caja-vieja', type: 'retrySale', targetLocalId: 'v1', note: null }, ADMIN,
        );

        const lista = await posHealthService.listDiagnostics();
        expect(lista.map((item) => item.deviceId)).toEqual(['caja-nueva', 'caja-vieja']);
        expect(lista.find((item) => item.deviceId === 'caja-vieja')?.pendingCommands).toBe(1);
        expect(lista.find((item) => item.deviceId === 'caja-nueva')?.pendingCommands).toBe(0);
        expect(new Date(lista[0].receivedAt).toISOString()).toBe(lista[0].receivedAt);
        expect(lista[0].reportedBy).toBe(CAJERO);
    });

    it('el detalle trae snapshot e historial de comandos, el más reciente primero', async () => {
        await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        const a = await posHealthService.createCommand(
            { deviceId: 'caja-01', type: 'retrySale', targetLocalId: 'v1', note: null }, ADMIN,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        const b = await posHealthService.createCommand(
            {
                deviceId: 'caja-01',
                type: 'sendSaleToUnreconciled',
                targetLocalId: 'v1',
                note: null,
            },
            ADMIN,
        );
        await terminar(a.id, 'failed', 'sin red');

        const detalle = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(detalle.snapshot.deviceId).toBe('caja-01');
        expect(detalle.snapshot.pendingCommands).toBe(1);
        expect(detalle.commands.map((command) => command.id)).toEqual([b.id, a.id]);
        expect(detalle.commands[1]).toMatchObject({ status: 'failed', result: 'sin red' });
    });

    it('404 si la caja nunca reportó', async () => {
        const error = await capturar(posHealthService.getDeviceDiagnostics('caja-fantasma'));
        expect(error.statusCode).toBe(404);
    });
});

describe('createCommand', () => {
    it('exige que la caja tenga snapshot (404)', async () => {
        const error = await capturar(posHealthService.createCommand(
            { deviceId: 'caja-fantasma', type: 'retrySale', targetLocalId: 'v1', note: null },
            ADMIN,
        ));
        expect(error.statusCode).toBe(404);
        const comandos = await db().collection('posCommands').get();
        expect(comandos.empty).toBe(true);
    });

    it('no duplica un pendiente idéntico: devuelve el existente y audita una vez', async () => {
        await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        const input = {
            deviceId: 'caja-01',
            type: 'retrySale' as const,
            targetLocalId: 'v1',
            note: null,
        };

        const primero = await posHealthService.createCommand(input, ADMIN);
        const repetido = await posHealthService.createCommand(
            { ...input, note: 'otra vez' }, ADMIN,
        );
        expect(repetido.id).toBe(primero.id);

        const comandos = await db().collection('posCommands').get();
        expect(comandos.size).toBe(1);

        const logs = await auditRepo.listAuditLogs({ action: 'pos.command_created' });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
            entity: 'posCommand',
            entityId: primero.id,
            userId: ADMIN.userId,
            roleSlug: 'admin',
        });
        expect(logs[0].metadata).toMatchObject({ deviceId: 'caja-01', type: 'retrySale' });
    });

    it('sí crea otro si el anterior ya terminó, o si cambia tipo u objetivo', async () => {
        await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        const input = {
            deviceId: 'caja-01',
            type: 'retrySale' as const,
            targetLocalId: 'v1',
            note: null,
        };

        const primero = await posHealthService.createCommand(input, ADMIN);
        await terminar(primero.id, 'failed', 'x');
        const reintento = await posHealthService.createCommand(input, ADMIN);
        const otroObjetivo = await posHealthService.createCommand(
            { ...input, targetLocalId: 'v2' }, ADMIN,
        );
        const otroTipo = await posHealthService.createCommand(
            { ...input, type: 'sendSaleToUnreconciled' }, ADMIN,
        );

        const ids = new Set([primero.id, reintento.id, otroObjetivo.id, otroTipo.id]);
        expect(ids.size).toBe(4);
    });
});

describe('completeCommand', () => {
    const crearPendiente = async () => {
        await posHealthService.reportDiagnostics(diagnostico(), CAJERO);
        return posHealthService.createCommand(
            { deviceId: 'caja-01', type: 'retrySale', targetLocalId: 'v1', note: null }, ADMIN,
        );
    };

    it('marca el pendiente con status, mensaje y completedAt', async () => {
        const comando = await crearPendiente();
        const hecho = await posHealthService.completeCommand(
            comando.id, { status: 'done', message: 'subida' }, CAJERO,
        );
        expect(hecho).toMatchObject({ id: comando.id, status: 'done', result: 'subida' });
        expect(hecho.completedAt).not.toBeNull();

        const doc = await db().collection('posCommands').doc(comando.id).get();
        expect(doc.get('status')).toBe('done');
        expect(doc.get('completedBy')).toBe(CAJERO);
    });

    it('es idempotente si se reporta otra vez el mismo status', async () => {
        const comando = await crearPendiente();
        const primero = await posHealthService.completeCommand(
            comando.id, { status: 'done', message: 'subida' }, CAJERO,
        );
        const repetido = await posHealthService.completeCommand(
            comando.id, { status: 'done', message: 'otro mensaje' }, CAJERO,
        );
        expect(repetido).toEqual(primero);
    });

    it('rechaza cambiar el desenlace (409)', async () => {
        const comando = await crearPendiente();
        await terminar(comando.id, 'done');
        const error = await capturar(posHealthService.completeCommand(
            comando.id, { status: 'failed', message: null }, CAJERO,
        ));
        expect(error.statusCode).toBe(409);
    });

    it('404 si lo reporta otra caja, y el comando sigue pendiente', async () => {
        const comando = await crearPendiente();
        const error = await capturar(posHealthService.completeCommand(
            comando.id, { status: 'done', message: null, deviceId: 'caja-99' }, CAJERO,
        ));
        expect(error.statusCode).toBe(404);
        const doc = await db().collection('posCommands').doc(comando.id).get();
        expect(doc.get('status')).toBe('pending');

        const hecho = await posHealthService.completeCommand(
            comando.id, { status: 'done', message: null, deviceId: 'caja-01' }, CAJERO,
        );
        expect(hecho.status).toBe('done');
    });

    it('404 si el comando no existe', async () => {
        const error = await capturar(posHealthService.completeCommand(
            'no-existe', { status: 'done', message: null }, CAJERO,
        ));
        expect(error.statusCode).toBe(404);
    });
});

describe('evaluateBlockedSalesAlert', () => {
    const ventas = (...ids: string[]) => ({ blockedSales: ids.map((localId) => ({ localId })) });

    it('alerta cuando aparecen ventas bloqueadas (antes ninguna o sin snapshot previo)', () => {
        expect(evaluateBlockedSalesAlert(null, ventas('v1'))).toMatchObject({
            shouldAlert: true, reason: 'appeared', previousCount: 0, currentCount: 1,
        });
        expect(evaluateBlockedSalesAlert(ventas(), ventas('v1')).reason).toBe('appeared');
    });

    it('alerta cuando el número sube y dice cuáles son nuevas', () => {
        expect(evaluateBlockedSalesAlert(ventas('v1'), ventas('v1', 'v2'))).toMatchObject({
            shouldAlert: true, reason: 'increased', newlyBlockedSaleIds: ['v2'],
        });
    });

    it('no alerta si sigue igual, baja o desaparece', () => {
        expect(evaluateBlockedSalesAlert(ventas('v1'), ventas('v1')).shouldAlert).toBe(false);
        expect(evaluateBlockedSalesAlert(ventas('v1', 'v2'), ventas('v2')).shouldAlert).toBe(false);
        expect(evaluateBlockedSalesAlert(ventas('v1'), ventas()).shouldAlert).toBe(false);
        expect(evaluateBlockedSalesAlert(null, ventas()).shouldAlert).toBe(false);
    });

    it('mismo número pero ventas distintas: no alerta, pero reporta la nueva', () => {
        const decision = evaluateBlockedSalesAlert(ventas('v1'), ventas('v2'));
        expect(decision.shouldAlert).toBe(false);
        expect(decision.newlyBlockedSaleIds).toEqual(['v2']);
    });
});
