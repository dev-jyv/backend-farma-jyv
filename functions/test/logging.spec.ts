import { HttpException, Logger } from '@nestjs/common';
import { AppExceptionFilter } from '../src/common/app-exception.filter';
import { AppError } from '../src/utils/errors';

/**
 * Los errores de producción tienen que dejar rastro. `logger: false` (desde el
 * primer commit) apagaba `Logger.error`: ningún 500 dejaba su stack y la causa de
 * uno real (un índice que faltaba) no se pudo ver en los logs.
 */

describe('arranque de la app: logger de Nest', () => {
    afterEach(() => jest.restoreAllMocks());

    it('deja activos los niveles error y warn', async () => {
        // `createApp` guarda la app en un módulo: se carga una copia fresca, y el
        // espía va sobre el `NestFactory` de esa misma copia.
        await jest.isolateModulesAsync(async () => {
            const { NestFactory } = await import('@nestjs/core');
            const create = jest.spyOn(NestFactory, 'create').mockResolvedValue({
                setGlobalPrefix: jest.fn(),
                init: jest.fn(),
            } as never);
            const { createApp } = await import('../src/app');

            await createApp();

            const options = create.mock.calls[0][2] as { logger: unknown };
            // `false` apaga todo; debe ser una lista con error y warn.
            expect(options.logger).not.toBe(false);
            expect(options.logger).toEqual(expect.arrayContaining(['error', 'warn']));
        });
    });
});

describe('AppExceptionFilter: registro de errores', () => {
    const buildHost = () => {
        const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const request = {
            method: 'GET',
            originalUrl: '/v1/products/abc/sales-history?page=1',
            body: { numeroDeTarjeta: '4111111111111111' },
            authUser: { uid: 'u-1', role: { slug: 'admin' } },
        };
        const host = {
            switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
        };
        return { host: host as never, response };
    };

    afterEach(() => jest.restoreAllMocks());

    it('un error inesperado deja el stack con la ruta y el usuario, y responde 500', () => {
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { host, response } = buildHost();

        new AppExceptionFilter().catch(new Error('FAILED_PRECONDITION: falta un índice'), host);

        expect(response.status).toHaveBeenCalledWith(500);
        const logged = String(error.mock.calls[0][0]);
        expect(logged).toContain('GET /v1/products/abc/sales-history?page=1');
        expect(logged).toContain('uid=u-1');
        expect(logged).toContain('rol=admin');
        expect(logged).toContain('FAILED_PRECONDITION: falta un índice');
        expect(logged).toContain('at '); // el stack
    });

    it('nunca registra el cuerpo de la petición', () => {
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { host } = buildHost();

        new AppExceptionFilter().catch(new Error('boom'), host);

        expect(String(error.mock.calls[0][0])).not.toContain('4111111111111111');
    });

    it('los errores esperados (AppError, HttpException) no se registran como 500', () => {
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const { host, response } = buildHost();

        const filter = new AppExceptionFilter();
        filter.catch(new AppError(404, 'NOT_FOUND', 'Producto no encontrado'), host);
        filter.catch(new HttpException('no', 403), host);

        expect(error).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenNthCalledWith(1, 404);
        expect(response.status).toHaveBeenNthCalledWith(2, 403);
    });
});
