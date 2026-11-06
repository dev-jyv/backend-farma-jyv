import { renderToStaticMarkup } from 'react-dom/server';
import { ReactElement } from 'react';
import * as posHealthService from '../src/services/pos-health.service';
import * as productsRepo from '../src/repositories/products.repository';
import {
    compareStockSample,
    repeatedStockDivergences,
} from '../src/services/pos-health-alerts.service';
import { sendReportEmail } from '../src/services/email.service';
import { POS_DIAGNOSTICS_LIMITS, posDiagnosticsSchema } from '../src/schemas';
import { PosDiagnosticsInput, PosStockDrift } from '../src/types';
import { db } from '../src/utils/firestore';
import { isVersionBelow } from '../src/utils/version';

/**
 * SPEC 67 — observabilidad de cajas: stock divergente contra el servidor, error
 * del actualizador y versión mínima. Resend está simulado.
 */

jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

const enviar = sendReportEmail as jest.MockedFunction<typeof sendReportEmail>;
const CAJERO = 'cashier-user';
const DIA = 24 * 60 * 60 * 1000;

const diagnostico = (overrides: Partial<PosDiagnosticsInput> = {}): PosDiagnosticsInput => ({
    deviceId: 'caja-01',
    deviceName: 'MOSTRADOR-1',
    appVersion: '1.0.9',
    platform: 'darwin',
    generatedAt: '2026-11-06T13:05:00.000Z',
    pendingSalesCount: 0,
    blockedSales: [],
    blockedCashSessions: [],
    unsyncedProducts: [],
    recentSyncRuns: [],
    syncLog: [],
    ...overrides,
});

const reportar = (overrides: Partial<PosDiagnosticsInput> = {}) =>
    posHealthService.reportDiagnostics(
        posDiagnosticsSchema.parse(diagnostico(overrides)),
        CAJERO,
    );

const guardado = async (deviceId = 'caja-01') =>
    (await db().collection('posDiagnostics').doc(deviceId).get()).data()!;

const crearProducto = async (id: string, name: string, totalStock: number) => {
    await db().collection('products').doc(id).set({ name, totalStock, isActive: true });
};

/** Deja en el snapshot una comparación hecha hace `dias` días. */
const compararHaceDias = async (dias: number, diverging: PosStockDrift['diverging']) => {
    await db().collection('posDiagnostics').doc('caja-01').update({
        stockDrift: {
            checkedAt: new Date(Date.now() - dias * DIA).toISOString(),
            compared: diverging.length,
            diverging,
        },
    });
};

beforeEach(async () => {
    enviar.mockClear();
    for (const name of ['posDiagnostics', 'posCommands', 'products']) {
        await db().recursiveDelete(db().collection(name));
    }
    await crearProducto('p-1', 'Paracetamol 500', 10);
    await crearProducto('p-2', 'Ibuprofeno 400', 4);
});

describe('esquema del diagnóstico (SPEC 67)', () => {
    it('acepta stockSample, updateError y updateCheckedAt; un POS viejo sin ellos también', () => {
        const nuevo = posDiagnosticsSchema.parse(diagnostico({
            stockSample: [{ productId: 'p-1', localStock: 3 }],
            updateError: 'Code signature not valid',
            updateCheckedAt: '2026-11-06T13:00:00.000Z',
        }));
        expect(nuevo.stockSample).toEqual([{ productId: 'p-1', localStock: 3 }]);
        expect(nuevo.updateError).toBe('Code signature not valid');
        expect(nuevo.updateCheckedAt).toBe('2026-11-06T13:00:00.000Z');

        const viejo = posDiagnosticsSchema.parse(diagnostico());
        expect(viejo.stockSample).toBeUndefined();
        expect(viejo.updateError ?? null).toBeNull();
    });

    it('recorta la muestra a 300 en vez de rechazar el diagnóstico', () => {
        const muestra = Array.from({ length: 320 }, (_, index) => ({
            productId: `p-${index}`,
            localStock: index,
        }));
        const parsed = posDiagnosticsSchema.parse(diagnostico({ stockSample: muestra }));
        expect(parsed.stockSample).toHaveLength(POS_DIAGNOSTICS_LIMITS.stockSample);
        expect(POS_DIAGNOSTICS_LIMITS.stockSample).toBe(300);
    });

    it('recorta un updateError largo', () => {
        const parsed = posDiagnosticsSchema.parse(diagnostico({ updateError: 'x'.repeat(900) }));
        expect(parsed.updateError).toHaveLength(500);
    });
});

describe('stockDrift (SPEC 67)', () => {
    it('una muestra con un producto distinto lo deja en stockDrift.diverging', async () => {
        await reportar({
            stockSample: [
                { productId: 'p-1', localStock: 7 },
                { productId: 'p-2', localStock: 4 },
                { productId: 'borrado', localStock: 2 },
            ],
        });

        const { snapshot } = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(snapshot.stockDrift).toEqual({
            checkedAt: expect.any(String),
            compared: 3,
            diverging: [
                { productId: 'p-1', name: 'Paracetamol 500', local: 7, server: 10 },
                // Borrado en el servidor: diverge con `server: null`.
                { productId: 'borrado', name: null, local: 2, server: null },
            ],
        });
        // La muestra no se guarda: solo su comparación.
        expect('stockSample' in await guardado()).toBe(false);
        // Una sola divergencia (el primer día) no manda correo.
        expect(enviar).not.toHaveBeenCalled();
    });

    it('ids inválidos o repetidos no rompen el reporte ni se comparan dos veces', async () => {
        await reportar({
            stockSample: [
                { productId: 'p-1', localStock: 10 },
                { productId: 'p-1', localStock: 1 },
                { productId: 'a/b', localStock: 1 },
                { productId: '', localStock: 1 },
            ],
        });
        const { snapshot } = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(snapshot.stockDrift).toMatchObject({ compared: 1, diverging: [] });
    });

    it('sin muestra se arrastra la comparación anterior; POS viejo se lee null', async () => {
        await reportar({ stockSample: [{ productId: 'p-1', localStock: 7 }] });
        await reportar();
        const { snapshot } = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(snapshot.stockDrift?.diverging.map((item) => item.productId)).toEqual(['p-1']);

        await reportar({ deviceId: 'caja-vieja' });
        const vieja = await posHealthService.getDeviceDiagnostics('caja-vieja');
        expect(vieja.snapshot.stockDrift).toBeNull();
        expect(vieja.snapshot.updateError).toBeNull();
        expect(vieja.snapshot.updateCheckedAt).toBeNull();
    });

    it('compara a lo más una vez al día: una segunda muestra del mismo día no lee', async () => {
        await reportar({ stockSample: [{ productId: 'p-1', localStock: 7 }] });
        const primera = (await posHealthService.getDeviceDiagnostics('caja-01')).snapshot;

        const leer = jest.spyOn(productsRepo, 'getStockByIds');
        await reportar({ stockSample: [{ productId: 'p-2', localStock: 0 }] });
        expect(leer).not.toHaveBeenCalled();
        leer.mockRestore();

        const segunda = (await posHealthService.getDeviceDiagnostics('caja-01')).snapshot;
        expect(segunda.stockDrift).toEqual(primera.stockDrift);
    });

    it('la misma divergencia dos días seguidos dispara el correo', async () => {
        await reportar();
        await compararHaceDias(1, [
            { productId: 'p-1', name: 'Paracetamol 500', local: 6, server: 10 },
            { productId: 'p-2', name: 'Ibuprofeno 400', local: 1, server: 4 },
        ]);

        await reportar({
            stockSample: [
                { productId: 'p-1', localStock: 7 },
                // p-2 ya cuadra hoy: no entra.
                { productId: 'p-2', localStock: 4 },
            ],
        });

        expect(enviar).toHaveBeenCalledTimes(1);
        const [{ subject, react }] = enviar.mock.calls[0];
        expect(subject).toBe(
            'Caja MOSTRADOR-1: 1 producto con stock distinto al servidor dos días seguidos',
        );
        const html = renderToStaticMarkup(react as ReactElement);
        expect(html).toContain('Paracetamol 500');
        expect(html).toContain('Caja 7 · Servidor 10');
        expect(html).toContain('-3 en la caja');
        expect(html).not.toContain('Ibuprofeno 400');
    });

    it('una divergencia de hace dos días (no seguidos) no alerta', async () => {
        await reportar();
        await compararHaceDias(2, [
            { productId: 'p-1', name: 'Paracetamol 500', local: 6, server: 10 },
        ]);
        await reportar({ stockSample: [{ productId: 'p-1', localStock: 7 }] });
        expect(enviar).not.toHaveBeenCalled();
    });

    it('si el correo falla la caja recibe su respuesta igual', async () => {
        enviar.mockRejectedValueOnce(new Error('Resend caído'));
        await reportar();
        await compararHaceDias(1, [
            { productId: 'p-1', name: 'Paracetamol 500', local: 6, server: 10 },
        ]);
        await expect(reportar({ stockSample: [{ productId: 'p-1', localStock: 7 }] }))
            .resolves.toEqual({ commands: [] });
        expect(enviar).toHaveBeenCalledTimes(1);
    });
});

describe('reglas puras de divergencia', () => {
    const server = new Map([['p-1', { name: 'A', totalStock: 5 }]]);

    it('limita a 50 divergentes en el orden de la muestra', () => {
        const muestra = Array.from({ length: 80 }, (_, index) => ({
            productId: `x-${index}`,
            localStock: 1,
        }));
        const drift = compareStockSample(muestra, server, new Date());
        expect(drift.compared).toBe(80);
        expect(drift.diverging).toHaveLength(50);
        expect(drift.diverging[0].productId).toBe('x-0');
    });

    it('repetidas: solo contra la comparación del día anterior', () => {
        const hoy = compareStockSample(
            [{ productId: 'p-1', localStock: 4 }],
            server,
            new Date('2026-11-06T15:00:00Z'),
        );
        const ayer = (checkedAt: string): PosStockDrift => ({
            checkedAt,
            compared: 1,
            diverging: [{ productId: 'p-1', name: 'A', local: 3, server: 5 }],
        });
        // 2026-11-05 09:00 en Ciudad de México.
        expect(repeatedStockDivergences(ayer('2026-11-05T15:00:00Z'), hoy)).toHaveLength(1);
        // 2026-11-05 23:30 local es 2026-11-06 05:30 UTC: sigue siendo ayer.
        expect(repeatedStockDivergences(ayer('2026-11-06T05:30:00Z'), hoy)).toHaveLength(1);
        expect(repeatedStockDivergences(ayer('2026-11-04T15:00:00Z'), hoy)).toHaveLength(0);
        expect(repeatedStockDivergences(null, hoy)).toHaveLength(0);
    });
});

describe('versión mínima y actualizador (SPEC 67)', () => {
    const ORIGINAL = process.env.POS_MIN_VERSION;
    afterEach(() => {
        if (ORIGINAL === undefined) {
            delete process.env.POS_MIN_VERSION;
        } else {
            process.env.POS_MIN_VERSION = ORIGINAL;
        }
    });

    it('isVersionBelow compara el núcleo numérico', () => {
        expect(isVersionBelow('1.0.9', '1.1.0')).toBe(true);
        expect(isVersionBelow('1.10.0', '1.9.3')).toBe(false);
        expect(isVersionBelow('v1.2.0', '1.2.0')).toBe(false);
        expect(isVersionBelow('1.2', '1.2.1')).toBe(true);
        expect(isVersionBelow('1.2.0-beta.1', '1.2.0')).toBe(false);
        expect(isVersionBelow('dev', '1.0.0')).toBe(false);
        expect(isVersionBelow('1.0.0', null)).toBe(false);
    });

    it('GET /pos/diagnostics marca belowMinVersion por caja', async () => {
        process.env.POS_MIN_VERSION = '1.1.0';
        await reportar({ appVersion: '1.0.9' });
        await reportar({ deviceId: 'caja-02', appVersion: '1.1.0' });

        const lista = await posHealthService.listDiagnostics();
        expect(lista.find((item) => item.deviceId === 'caja-01')?.belowMinVersion).toBe(true);
        expect(lista.find((item) => item.deviceId === 'caja-02')?.belowMinVersion).toBe(false);
        const { snapshot } = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(snapshot.belowMinVersion).toBe(true);
        // No se guarda: depende de la variable al leer.
        expect('belowMinVersion' in await guardado()).toBe(false);
    });

    it('sin POS_MIN_VERSION ninguna caja sale marcada', async () => {
        delete process.env.POS_MIN_VERSION;
        await reportar({ appVersion: '0.0.1' });
        const [caja] = await posHealthService.listDiagnostics();
        expect(caja.belowMinVersion).toBe(false);
    });

    it('guarda y devuelve updateError y updateCheckedAt', async () => {
        await reportar({
            updateError: 'Could not get code signature for running application',
            updateCheckedAt: '2026-11-06T13:00:00.000Z',
        });
        const { snapshot } = await posHealthService.getDeviceDiagnostics('caja-01');
        expect(snapshot.updateError).toBe('Could not get code signature for running application');
        expect(snapshot.updateCheckedAt).toBe('2026-11-06T13:00:00.000Z');
    });
});
