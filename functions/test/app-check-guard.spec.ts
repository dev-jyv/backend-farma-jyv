import { EventEmitter } from 'events';
import { ExecutionContext } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import * as logger from 'firebase-functions/logger';

import { getAppCheckMode } from '../src/config/env';
import { IS_PUBLIC_KEY } from '../src/modules/identity/decorators/public.decorator';
import {
    APP_CHECK_VERIFY_TIMEOUT_MS,
    AppCheckGuard,
    classifyClient,
} from '../src/modules/identity/guards/app-check.guard';

const mockVerifyToken = jest.fn();

jest.mock('firebase-admin/app-check', () => ({
    getAppCheck: () => ({ verifyToken: mockVerifyToken }),
}));

jest.mock('firebase-functions/logger', () => ({
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
}));

/**
 * SPEC 41: App Check en modo registro. Lo que se fija aquí es que el guard
 * **nunca** rechaza —en este spec no existe `enforce`— y que el log deja lo que
 * la consulta de Logging necesita para separar al panel de la caja y de un
 * script: resultado, ruta, uid verificado y `User-Agent`.
 */

const UA_PANEL =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/130.0.0.0 Safari/537.36';
const UA_POS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'farma-jyv-pos/1.4.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';

type FakeRequest = {
    headers: Record<string, string | string[] | undefined>;
    path: string;
    method: string;
    authUser?: { uid: string };
};

type FakeResponse = EventEmitter & { statusCode: number };

const warn = logger.warn as jest.Mock;

const build = (
    { headers = {}, esPublica = false }: {
        headers?: Record<string, string>;
        esPublica?: boolean;
    } = {},
) => {
    const req: FakeRequest = {
        headers: { 'user-agent': UA_PANEL, ...headers },
        path: '/v1/products',
        method: 'GET',
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as FakeResponse;
    const context = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
        getHandler: () => () => undefined,
        getClass: () => class {},
    } as unknown as ExecutionContext;
    const reflector = {
        getAllAndOverride: jest.fn((key: string) =>
            key === IS_PUBLIC_KEY ? esPublica : undefined,
        ),
    } as unknown as Reflector;
    return { guard: new AppCheckGuard(reflector), context, req, res };
};

/** Simula lo que pasa después del guard: AuthGuard resuelve el uid y se responde. */
const terminar = (req: FakeRequest, res: FakeResponse, uid?: string, status = 200) => {
    if (uid) {
        req.authUser = { uid };
    }
    res.statusCode = status;
    res.emit('close');
};

describe('AppCheckGuard (modo registro)', () => {
    const originalMode = process.env.APP_CHECK_MODE;

    beforeEach(() => {
        process.env.APP_CHECK_MODE = 'log';
        mockVerifyToken.mockReset();
        warn.mockClear();
    });

    afterAll(() => {
        if (originalMode === undefined) {
            delete process.env.APP_CHECK_MODE;
        } else {
            process.env.APP_CHECK_MODE = originalMode;
        }
    });

    it('sin cabecera deja pasar y registra `missing` con ruta, uid y User-Agent', async () => {
        const { guard, context, req, res } = build();

        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(mockVerifyToken).not.toHaveBeenCalled();
        // El uid lo resuelve AuthGuard después: el log espera al cierre.
        expect(warn).not.toHaveBeenCalled();

        terminar(req, res, 'uid-1');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({
            appCheck: 'missing',
            path: '/v1/products',
            method: 'GET',
            uid: 'uid-1',
            userAgent: UA_PANEL,
            client: 'navegador',
            status: 200,
        }));
    });

    it('un token válido no deja log', async () => {
        mockVerifyToken.mockResolvedValue({ appId: 'app', token: {} });
        const { guard, context, req, res } = build({
            headers: { 'x-firebase-appcheck': 'tok-valido' },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        terminar(req, res, 'uid-1');

        expect(mockVerifyToken).toHaveBeenCalledWith('tok-valido');
        expect(warn).not.toHaveBeenCalled();
    });

    it('un token inválido o vencido pasa y se registra como `invalid`', async () => {
        mockVerifyToken.mockRejectedValue(new Error('app-check/token-expired'));
        const { guard, context, req, res } = build({
            headers: { 'x-firebase-appcheck': 'tok-vencido' },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        terminar(req, res, 'uid-2');

        expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({
            appCheck: 'invalid',
            uid: 'uid-2',
            reason: 'app-check/token-expired',
        }));
    });

    it('si el servicio de verificación se cuelga, registra `invalid` al tope y pasa', async () => {
        jest.useFakeTimers();
        try {
            mockVerifyToken.mockReturnValue(new Promise(() => undefined));
            const { guard, context, req, res } = build({
                headers: { 'x-firebase-appcheck': 'tok' },
            });

            const pending = guard.canActivate(context);
            await jest.advanceTimersByTimeAsync(APP_CHECK_VERIFY_TIMEOUT_MS + 1);

            await expect(pending).resolves.toBe(true);
            terminar(req, res);
            expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({
                appCheck: 'invalid',
                uid: null,
            }));
        } finally {
            jest.useRealTimers();
        }
    });

    it('la caja sale como `missing` con cliente `pos`, separada del panel', async () => {
        const { guard, context, req, res } = build({ headers: { 'user-agent': UA_POS } });

        await guard.canActivate(context);
        terminar(req, res, 'cajero-1');

        expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({
            appCheck: 'missing',
            client: 'pos',
            userAgent: UA_POS,
        }));
    });

    it('una petición que AuthGuard rechaza también queda registrada, sin uid', async () => {
        const { guard, context, req, res } = build();

        await guard.canActivate(context);
        terminar(req, res, undefined, 401);

        expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({
            appCheck: 'missing',
            uid: null,
            status: 401,
        }));
    });

    it('las rutas @Public() no se verifican ni se registran', async () => {
        const { guard, context, req, res } = build({
            esPublica: true,
            headers: { 'x-firebase-appcheck': 'tok' },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        terminar(req, res);

        expect(mockVerifyToken).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('con APP_CHECK_MODE=off no verifica ni registra', async () => {
        process.env.APP_CHECK_MODE = 'off';
        const { guard, context, req, res } = build({
            headers: { 'x-firebase-appcheck': 'tok' },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        terminar(req, res, 'uid-1');

        expect(mockVerifyToken).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('getAppCheckMode', () => {
    const snapshot = { ...process.env };

    afterEach(() => {
        process.env = { ...snapshot };
    });

    it('sin variable: `off` en emulador y pruebas, `log` desplegado', () => {
        delete process.env.APP_CHECK_MODE;
        delete process.env.K_SERVICE;
        expect(getAppCheckMode()).toBe('off');

        process.env.K_SERVICE = 'api';
        expect(getAppCheckMode()).toBe('log');

        process.env.FUNCTIONS_EMULATOR = 'true';
        expect(getAppCheckMode()).toBe('off');
    });

    it('acepta off y log sin importar mayúsculas', () => {
        process.env.APP_CHECK_MODE = ' OFF ';
        expect(getAppCheckMode()).toBe('off');
        process.env.APP_CHECK_MODE = 'Log';
        expect(getAppCheckMode()).toBe('log');
    });

    it('`enforce` no existe en este spec: se trata como `log`, nunca rechaza', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        process.env.APP_CHECK_MODE = 'enforce';
        expect(getAppCheckMode()).toBe('log');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('classifyClient', () => {
    it('separa caja, navegador y scripts por User-Agent', () => {
        expect(classifyClient(UA_POS)).toBe('pos');
        expect(classifyClient(UA_PANEL)).toBe('navegador');
        expect(classifyClient('curl/8.7.1')).toBe('script');
        expect(classifyClient(undefined)).toBe('sin-user-agent');
    });
});

describe('AppModule: orden de los guards globales', () => {
    it('App Check corre antes que AuthGuard y PermissionsGuard', async () => {
        const { AppModule } = await import('../src/app.module');
        const providers = Reflect.getMetadata('providers', AppModule) as Array<{
            provide?: unknown;
            useClass?: { name: string };
        }>;
        const guards = providers
            .filter((p) => p.provide === APP_GUARD)
            .map((p) => p.useClass?.name);

        expect(guards).toEqual(['AppCheckGuard', 'AuthGuard', 'PermissionsGuard']);
    });
});
