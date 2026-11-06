import type { Request, Response } from 'express';
import { corsMiddleware } from '../src/middleware/cors';

/**
 * SPEC 65: la caja y el panel miden el desfase de su reloj con el header `Date`
 * de la respuesta. En un navegador solo se puede leer si CORS lo expone.
 */
const run = (method: string): Promise<Record<string, string>> => new Promise((resolve) => {
    const headers: Record<string, string> = {};
    const req = {
        method,
        headers: {
            origin: 'http://localhost:4200',
            ...(method === 'OPTIONS' ? { 'access-control-request-method': 'GET' } : {}),
        },
    } as unknown as Request;
    const res = {
        statusCode: 200,
        setHeader: (name: string, value: string) => {
            headers[name.toLowerCase()] = String(value);
        },
        getHeader: (name: string) => headers[name.toLowerCase()],
        end: () => resolve(headers),
    } as unknown as Response;
    corsMiddleware(req, res, () => resolve(headers));
});

describe('CORS (SPEC 65)', () => {
    const ORIGINS = process.env.CORS_ORIGINS;
    beforeAll(() => {
        process.env.CORS_ORIGINS = 'http://localhost:4200';
    });
    afterAll(() => {
        if (ORIGINS === undefined) {
            delete process.env.CORS_ORIGINS;
        } else {
            process.env.CORS_ORIGINS = ORIGINS;
        }
    });

    it('expone el header Date en las respuestas', async () => {
        const headers = await run('GET');
        expect(headers['access-control-allow-origin']).toBe('http://localhost:4200');
        expect(headers['access-control-expose-headers']).toBe('Date');
    });
});
