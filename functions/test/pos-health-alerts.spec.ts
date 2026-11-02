import { Timestamp } from 'firebase-admin/firestore';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactElement } from 'react';
import * as posHealthService from '../src/services/pos-health.service';
import * as diagnosticsRepo from '../src/repositories/pos-diagnostics.repository';
import {
    POS_SILENCE_THRESHOLD_MS,
    evaluateBlockedSalesAlert,
    shouldAlertSilence,
} from '../src/services/pos-health-alerts.service';
import {
    checkSilentDevices,
    formatLocalReportTime,
    formatSilentFor,
} from '../src/services/pos-health-alerts-sender.service';
import { sendReportEmail } from '../src/services/email.service';
import { posDiagnosticsSchema } from '../src/schemas';
import { PosDiagnosticsInput } from '../src/types';
import { db } from '../src/utils/firestore';

/**
 * Alertas por correo de la salud de cajas (SPEC 44), contra el emulador:
 *
 * - ventas bloqueadas que **aparecen o crecen** → un correo desde el propio
 *   reporte, sin que un fallo de Resend tumbe la respuesta a la caja;
 * - caja con turno abierto que lleva más de 2 h sin reportar → un correo de la
 *   revisión horaria, **uno solo** por caída (`silenceAlertedAt`).
 *
 * Resend está simulado: se afirma sobre qué se mandó (asunto y contenido
 * renderizado), no sobre la entrega.
 */

jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

const enviar = sendReportEmail as jest.MockedFunction<typeof sendReportEmail>;

const CAJERO = 'cashier-user';
const HORA = 60 * 60 * 1000;

const venta = (localId: string, total = 120.5) => ({
    localId,
    folio: `F-${localId}`,
    total,
    createdAt: '2026-10-01T10:00:00.000Z',
    cashSessionId: 'turno-1',
    pushError: `Rechazada ${localId}`,
    waitingFor: 'servidor' as const,
    blockers: [],
});

const diagnostico = (overrides: Partial<PosDiagnosticsInput> = {}): PosDiagnosticsInput => ({
    deviceId: 'caja-01',
    deviceName: 'MOSTRADOR-1',
    appVersion: '1.0.9',
    platform: 'win32',
    generatedAt: '2026-10-01T10:05:00.000Z',
    pendingSalesCount: 2,
    blockedSales: [],
    blockedCashSessions: [],
    unsyncedProducts: [],
    recentSyncRuns: [],
    syncLog: [],
    openCashSessionId: 'turno-remoto-1',
    ...overrides,
});

const reportar = (overrides: Partial<PosDiagnosticsInput> = {}) =>
    posHealthService.reportDiagnostics(diagnostico(overrides), CAJERO);

/** Lleva el último reporte de la caja `horas` atrás, como si se hubiera callado. */
const envejecer = async (deviceId: string, horas: number, desde = Date.now()) => {
    await db().collection('posDiagnostics').doc(deviceId).update({
        receivedAt: Timestamp.fromMillis(desde - horas * HORA),
    });
};

const correos = () => enviar.mock.calls.map(([input]) => ({
    subject: input.subject,
    html: renderToStaticMarkup(input.react as ReactElement),
}));

beforeEach(async () => {
    enviar.mockReset();
    enviar.mockResolvedValue(undefined);
    for (const name of ['posDiagnostics', 'posCommands']) {
        await db().recursiveDelete(db().collection(name));
    }
});

describe('posDiagnosticsSchema.openCashSessionId', () => {
    it('es opcional: un POS sin actualizar no se rechaza', () => {
        const { openCashSessionId: _omitido, ...viejo } = diagnostico();
        const parsed = posDiagnosticsSchema.parse(viejo);
        expect(parsed.openCashSessionId).toBeUndefined();
    });

    it('acepta null (sin turno) y un id', () => {
        expect(posDiagnosticsSchema.parse(diagnostico({ openCashSessionId: null }))
            .openCashSessionId).toBeNull();
        expect(posDiagnosticsSchema.parse(diagnostico()).openCashSessionId)
            .toBe('turno-remoto-1');
    });

    it('rechaza ids de más de 128 caracteres', () => {
        const result = posDiagnosticsSchema.safeParse(
            diagnostico({ openCashSessionId: 'x'.repeat(129) }),
        );
        expect(result.success).toBe(false);
    });
});

describe('alerta de ventas bloqueadas desde reportDiagnostics', () => {
    it('aparecen: correo con razón appeared; el mismo reporte no manda otro', async () => {
        await reportar();
        expect(enviar).not.toHaveBeenCalled();

        await reportar({ blockedSales: [venta('v1')] });
        expect(enviar).toHaveBeenCalledTimes(1);
        const [correo] = correos();
        expect(correo.subject).toBe('Caja MOSTRADOR-1: 1 ventas bloqueadas');
        expect(correo.html).toContain('Aparecieron ventas bloqueadas');
        expect(correo.html).toContain('F-v1');
        expect(correo.html).toContain('MOSTRADOR-1');

        await reportar({ blockedSales: [venta('v1')] });
        expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('la primera vez que reporta una caja con bloqueadas también avisa (appeared)', async () => {
        await reportar({ blockedSales: [venta('v1'), venta('v2')] });
        expect(enviar).toHaveBeenCalledTimes(1);
        expect(correos()[0].subject).toBe('Caja MOSTRADOR-1: 2 ventas bloqueadas');
    });

    it('bajan y vuelven a subir: avisa por increased', async () => {
        await reportar({ blockedSales: [venta('v1'), venta('v2')] });
        await reportar({ blockedSales: [venta('v1')] });
        expect(enviar).toHaveBeenCalledTimes(1);

        await reportar({ blockedSales: [venta('v1'), venta('v3')] });
        expect(enviar).toHaveBeenCalledTimes(2);
        const segundo = correos()[1];
        expect(segundo.subject).toBe('Caja MOSTRADOR-1: 2 ventas bloqueadas');
        expect(segundo.html).toContain('Aumentaron las ventas bloqueadas');
        expect(segundo.html).toContain('F-v3 · nueva');
    });

    it('Resend caído: la caja recibe su respuesta y el snapshot se guarda', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        enviar.mockRejectedValue(new Error('Resend 503'));

        await expect(reportar({ blockedSales: [venta('v1')] })).resolves.toEqual({ commands: [] });

        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('blockedSales')).toHaveLength(1);
        expect(error).toHaveBeenCalledWith(
            'No se pudo mandar la alerta de ventas bloqueadas',
            expect.objectContaining({ deviceId: 'caja-01', error: 'Resend 503' }),
        );
        error.mockRestore();
    });

    it('un envío lento no retiene la respuesta más allá del tope', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            enviar.mockImplementation(() => new Promise(() => undefined));
            const respuesta = reportar({ blockedSales: [venta('v1')] });
            // Deja correr las lecturas/escrituras reales hasta que el envío arranque.
            while (enviar.mock.calls.length === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            jest.advanceTimersByTime(posHealthService.BLOCKED_SALES_ALERT_TIMEOUT_MS);
            await expect(respuesta).resolves.toEqual({ commands: [] });
        } finally {
            jest.useRealTimers();
            warn.mockRestore();
        }
    });

    it('un diagnóstico sin openCashSessionId se guarda sin el campo', async () => {
        const { openCashSessionId: _omitido, ...viejo } = diagnostico();
        await posHealthService.reportDiagnostics(posDiagnosticsSchema.parse(viejo), CAJERO);
        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('openCashSessionId')).toBeUndefined();
        expect(doc.get('silenceAlertedAt')).toBeNull();
    });
});

describe('shouldAlertSilence', () => {
    const ahora = Date.parse('2026-11-02T18:00:00Z');
    const base = {
        receivedAt: new Date(ahora - 3 * HORA),
        openCashSessionId: 'turno-1' as string | null | undefined,
        silenceAlertedAt: null as Date | null,
    };

    it('turno abierto y más de 2 h sin reportar: avisa', () => {
        expect(shouldAlertSilence(base, ahora)).toBe(true);
    });

    it('exactamente el umbral todavía no', () => {
        expect(shouldAlertSilence(
            { ...base, receivedAt: new Date(ahora - POS_SILENCE_THRESHOLD_MS) },
            ahora,
        )).toBe(false);
    });

    it('sin turno abierto (null) o POS sin actualizar (sin campo): no avisa', () => {
        expect(shouldAlertSilence({ ...base, openCashSessionId: null }, ahora)).toBe(false);
        expect(shouldAlertSilence({ ...base, openCashSessionId: undefined }, ahora)).toBe(false);
    });

    it('ya avisada desde ese reporte: no repite', () => {
        expect(shouldAlertSilence({ ...base, silenceAlertedAt: new Date(ahora - HORA) }, ahora))
            .toBe(false);
    });
});

describe('checkSilentDevices (revisión horaria)', () => {
    it('caja con turno abierto callada > 2 h: un correo, uno solo', async () => {
        await reportar({ pendingSalesCount: 4, blockedSales: [venta('v1')] });
        enviar.mockClear();
        await envejecer('caja-01', 3);

        const primera = await checkSilentDevices();
        expect(primera.alerted).toEqual(['caja-01']);
        expect(enviar).toHaveBeenCalledTimes(1);
        const [correo] = correos();
        expect(correo.subject).toMatch(/^Caja MOSTRADOR-1 sin sincronizar desde \d{2}:\d{2}$/);
        expect(correo.html).toContain('MOSTRADOR-1');
        expect(correo.html).toContain('Ventas pendientes de subir');
        expect(correo.html).toContain('>4<');
        expect(correo.html).toContain('Ventas bloqueadas');

        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('silenceAlertedAt')).toBeInstanceOf(Timestamp);

        // Sin red todo el día: las corridas siguientes no repiten el correo.
        for (const horas of [1, 2, 5]) {
            const corrida = await checkSilentDevices(new Date(Date.now() + horas * HORA));
            expect(corrida.alerted).toEqual([]);
        }
        expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('vuelve a reportar y se vuelve a caer: segundo correo', async () => {
        await reportar();
        await envejecer('caja-01', 3);
        await checkSilentDevices();
        expect(enviar).toHaveBeenCalledTimes(1);

        await reportar();
        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('silenceAlertedAt')).toBeNull();
        expect((await checkSilentDevices()).alerted).toEqual([]);

        await envejecer('caja-01', 3);
        expect((await checkSilentDevices()).alerted).toEqual(['caja-01']);
        expect(enviar).toHaveBeenCalledTimes(2);
    });

    it('caja apagada sin turno abierto: no genera correo', async () => {
        await reportar({ openCashSessionId: null });
        await envejecer('caja-01', 10);

        const result = await checkSilentDevices();
        expect(result.checked).toBe(1);
        expect(result.alerted).toEqual([]);
        expect(enviar).not.toHaveBeenCalled();
    });

    it('caja con POS sin actualizar (sin openCashSessionId): no avisa por silencio', async () => {
        const { openCashSessionId: _omitido, ...viejo } = diagnostico();
        await posHealthService.reportDiagnostics(posDiagnosticsSchema.parse(viejo), CAJERO);
        await envejecer('caja-01', 10);

        expect((await checkSilentDevices()).alerted).toEqual([]);
        expect(enviar).not.toHaveBeenCalled();
    });

    it('menos de 2 h sin reportar: no avisa', async () => {
        await reportar();
        await envejecer('caja-01', 1.5);
        const result = await checkSilentDevices();
        expect(result.checked).toBe(0);
        expect(enviar).not.toHaveBeenCalled();
    });

    it('solo avisa a la caja callada, no a las que reportan', async () => {
        await reportar({ deviceId: 'caja-01', deviceName: 'MOSTRADOR-1' });
        await reportar({ deviceId: 'caja-02', deviceName: 'MOSTRADOR-2' });
        await envejecer('caja-02', 4);

        expect((await checkSilentDevices()).alerted).toEqual(['caja-02']);
        expect(correos()[0].subject).toMatch(/^Caja MOSTRADOR-2 sin sincronizar desde /);
    });

    it('si el correo falla deshace la marca y la siguiente hora reintenta', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        await reportar();
        await envejecer('caja-01', 3);
        enviar.mockRejectedValueOnce(new Error('Resend 503'));

        const fallida = await checkSilentDevices();
        expect(fallida).toMatchObject({ alerted: [], failed: ['caja-01'] });
        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('silenceAlertedAt')).toBeNull();

        expect((await checkSilentDevices()).alerted).toEqual(['caja-01']);
        error.mockRestore();
    });

    it('si la caja reportó entre la consulta y la marca, no avisa', async () => {
        await reportar();
        await envejecer('caja-01', 3);
        const [candidata] = await diagnosticsRepo.listSilentSince(new Date(Date.now() - 2 * HORA));

        await reportar();
        expect(await diagnosticsRepo.claimSilenceAlert('caja-01', candidata.updateTime))
            .toBeNull();
        const doc = await db().collection('posDiagnostics').doc('caja-01').get();
        expect(doc.get('silenceAlertedAt')).toBeNull();
    });

    it('expone silenceAlertedAt en el listado del panel', async () => {
        await reportar();
        await envejecer('caja-01', 3);
        await checkSilentDevices();
        const [snapshot] = await posHealthService.listDiagnostics();
        expect(typeof snapshot.silenceAlertedAt).toBe('string');
    });
});

describe('formato de hora y duración', () => {
    // 19:00 en México es 01:00 UTC del día siguiente: el asunto tiene que decir 19:00.
    const ahora = new Date('2026-11-03T02:00:00Z');

    it('mismo día local: solo la hora', () => {
        expect(formatLocalReportTime(new Date('2026-11-03T01:00:00Z'), ahora)).toBe('19:00');
    });

    it('otro día local: día/mes y hora', () => {
        expect(formatLocalReportTime(new Date('2026-11-01T21:30:00Z'), ahora)).toBe('01/11 15:30');
    });

    it('duración legible', () => {
        expect(formatSilentFor(45 * 60_000)).toBe('45 min');
        expect(formatSilentFor(3 * HORA + 5 * 60_000)).toBe('3 h 05 min');
        expect(formatSilentFor(50 * HORA)).toBe('2 d 2 h');
    });
});

describe('evaluateBlockedSalesAlert con el snapshot guardado', () => {
    it('getPreviousBlockedSales devuelve null si la caja nunca reportó', async () => {
        expect(await diagnosticsRepo.getPreviousBlockedSales('nunca')).toBeNull();
    });

    it('compara contra lo que quedó guardado (solo blockedSales)', async () => {
        await reportar({ blockedSales: [venta('v1')] });
        const previo = await diagnosticsRepo.getPreviousBlockedSales('caja-01');
        expect(previo?.blockedSales.map((sale) => sale.localId)).toEqual(['v1']);
        expect(evaluateBlockedSalesAlert(previo, { blockedSales: [venta('v1')] }).shouldAlert)
            .toBe(false);
    });
});
