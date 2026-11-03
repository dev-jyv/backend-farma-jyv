import 'reflect-metadata';
import { readFileSync } from 'fs';
import { AddressInfo } from 'net';
import { join } from 'path';
import { Server } from 'http';
import express from 'express';
import * as admin from 'firebase-admin';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { createUserProfile } from '../src/repositories/users.repository';
import { AppModule } from '../src/app.module';
import { ReportsPdfModule } from '../src/reports-pdf.module';
import { createHttpApp } from '../src/common/http-pipeline';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import { RolePermission } from '../src/types';

/**
 * SPEC 38: los PDF que lanzan Chromium salen de `api` a la función `reportsPdf`.
 * Lo que se fija aquí es que la mudanza no cambie nada visible: las 11 rutas
 * responden igual desde las dos apps (estado, cabeceras, cuerpo, permisos,
 * CORS), y `api` las sigue sirviendo mientras el panel viejo esté en producción.
 *
 * Chromium se sustituye: no es lo que se prueba, y lanzarlo once veces por
 * app haría la suite lenta e inestable. Lo que sí corre es todo lo demás —
 * guards, pipes, `authorize` de cada reporte, filtro de errores, CORS— contra
 * el emulador de Firestore.
 */

const PDF_FALSO = Buffer.from('%PDF-1.4 falso');

jest.mock('../src/services/report-pdf.service', () => ({
    ...jest.requireActual('../src/services/report-pdf.service'),
    renderHtmlToPdf: jest.fn(async () => PDF_FALSO),
}));

const ORIGEN_PERMITIDO = 'https://panel.farmajyv.test';
const ORIGEN_AJENO = 'https://ajeno.example';

const MES = '2026-10';
const DESDE = '2026-10-01T06:00:00.000Z';
const HASTA = '2026-11-01T05:59:59.999Z';

/** Las 11 rutas PDF del spec, con parámetros válidos y el área que las protege. */
const RUTAS_PDF: { ruta: string; area: 'dashboard' | 'accounting' }[] = [
    {
        ruta: '/v1/reports/exports/sales-daily.pdf?date=2026-10-15&scope=financial',
        area: 'dashboard',
    },
    { ruta: `/v1/reports/exports/sales-monthly.pdf?month=${MES}`, area: 'dashboard' },
    { ruta: '/v1/reports/exports/inventory.pdf', area: 'dashboard' },
    { ruta: '/v1/reports/exports/low-stock.pdf', area: 'dashboard' },
    { ruta: '/v1/reports/exports/expiring.pdf', area: 'dashboard' },
    { ruta: '/v1/reports/exports/no-cost.pdf', area: 'dashboard' },
    { ruta: `/v1/reports/exports/expenses-monthly.pdf?month=${MES}`, area: 'dashboard' },
    { ruta: `/v1/reports/exports/invoices.pdf?month=${MES}`, area: 'dashboard' },
    { ruta: '/v1/reports/exports/inventario?format=pdf', area: 'dashboard' },
    {
        ruta: `/v1/accounting/exports/income-statement.pdf?from=${DESDE}&to=${HASTA}`,
        area: 'accounting',
    },
    { ruta: '/v1/accounting/exports/balance-sheet.pdf', area: 'accounting' },
];

type Perfil = { slug: string; permissions: RolePermission[] };

const PERFILES: Record<string, Perfil> = {
    admin: { slug: 'admin', permissions: [] },
    // Cajero: vende y lee ventas, pero no tiene `dashboard` ni `accounting`.
    cajero: {
        slug: 'cashier',
        permissions: [{ area: 'pos', level: 'write' }, { area: 'sales', level: 'read' }],
    },
    // Rol personalizado con solo analítica: reportes sí, contabilidad no, y el
    // libro de controlados tampoco (su `authorize` exige administrador o gerente).
    analista: { slug: 'analista', permissions: [{ area: 'dashboard', level: 'read' }] },
};

const sesion = Math.floor(Date.now() / 1000);

/** Token → claims. Un token que no está aquí se trata como vencido. */
const tokens = new Map<string, Record<string, unknown>>();

const servir = async (app: express.Application): Promise<{ base: string; server: Server }> => {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, server };
};

let api: { base: string; server: Server };
let pdf: { base: string; server: Server };
const corsOriginal = process.env.CORS_ORIGINS;

beforeAll(async () => {
    process.env.CORS_ORIGINS = ORIGEN_PERMITIDO;

    for (const [nombre, perfil] of Object.entries(PERFILES)) {
        const uid = `uid-${nombre}`;
        const roleId = `rol-${nombre}`;
        await createUserProfile(uid, {
            email: `${nombre}@farmajyv.test`,
            displayName: nombre,
            roleId,
            permissionsVersion: 1,
            isActive: true,
        });
        tokens.set(`token-${nombre}`, {
            uid,
            auth_time: sesion,
            roleId,
            roleSlug: perfil.slug,
            roleName: nombre,
            permissions: perfil.permissions,
            permissionsVersion: 1,
        });
    }

    jest.spyOn(admin, 'auth').mockReturnValue({
        verifyIdToken: jest.fn(async (token: string) => {
            const claims = tokens.get(token);
            if (!claims) {
                throw Object.assign(new Error('Firebase ID token has expired.'), {
                    code: 'auth/id-token-expired',
                });
            }
            return claims;
        }),
    } as unknown as admin.auth.Auth);

    // Mismo `createHttpApp` que `index.ts`, sin la caché de módulo de cada app.
    api = await servir(await createHttpApp(AppModule));
    pdf = await servir(await createHttpApp(ReportsPdfModule));
});

afterAll(async () => {
    process.env.CORS_ORIGINS = corsOriginal;
    jest.restoreAllMocks();
    await Promise.all([api, pdf].map(({ server }) =>
        new Promise<void>((resolve) => server.close(() => resolve()))));
});

type Respuesta = {
    status: number;
    tipo: string | null;
    disposicion: string | null;
    exponer: string | null;
    origen: string | null;
    cuerpo: Buffer;
};

const pedir = async (
    base: string,
    ruta: string,
    opciones: { token?: string; origin?: string; method?: string } = {},
): Promise<Respuesta> => {
    const headers: Record<string, string> = {};
    if (opciones.token) {
        headers.Authorization = `Bearer ${opciones.token}`;
    }
    if (opciones.origin) {
        headers.Origin = opciones.origin;
    }
    const res = await fetch(`${base}${ruta}`, { method: opciones.method ?? 'GET', headers });
    return {
        status: res.status,
        tipo: res.headers.get('content-type'),
        disposicion: res.headers.get('content-disposition'),
        exponer: res.headers.get('access-control-expose-headers'),
        origen: res.headers.get('access-control-allow-origin'),
        cuerpo: Buffer.from(await res.arrayBuffer()),
    };
};

const enAmbas = async (ruta: string, opciones: Parameters<typeof pedir>[2] = {}) => {
    const [desdeApi, desdePdf] = await Promise.all([
        pedir(api.base, ruta, opciones),
        pedir(pdf.base, ruta, opciones),
    ]);
    return { desdeApi, desdePdf };
};

describe('reportsPdf: las 11 rutas PDF', () => {
    it('declara exactamente las 11 rutas, con el permiso de cada una', () => {
        const rutas: string[] = [];
        const controllers = Reflect.getMetadata('controllers', ReportsPdfModule) as {
            prototype: object;
        }[];
        for (const controller of controllers) {
            const prefijo = Reflect.getMetadata(PATH_METADATA, controller) as string;
            const proto = controller.prototype as Record<string, unknown>;
            for (const nombre of Object.getOwnPropertyNames(proto)) {
                const handler = proto[nombre];
                if (typeof handler !== 'function' ||
                    Reflect.getMetadata(METHOD_METADATA, handler) === undefined) {
                    continue;
                }
                const permiso = Reflect.getMetadata(PERMISSION_KEY, handler) as
                    | { area: string; level: string }
                    | { anyOf: { area: string; level: string }[] };
                // `:report` entra con dashboard o reportDownloads (SPEC 45).
                const opciones = 'anyOf' in permiso ? permiso.anyOf : [permiso];
                rutas.push(`${prefijo}/${Reflect.getMetadata(PATH_METADATA, handler)} ` +
                    opciones.map((p) => `${p.area}:${p.level}`).join('|'));
            }
        }

        expect(rutas.sort()).toEqual([
            'accounting/exports/balance-sheet.pdf accounting:read',
            'accounting/exports/income-statement.pdf accounting:read',
            'reports/exports/:report dashboard:read|reportDownloads:read',
            'reports/exports/expenses-monthly.pdf dashboard:read',
            'reports/exports/expiring.pdf dashboard:read',
            'reports/exports/inventory.pdf dashboard:read',
            'reports/exports/invoices.pdf dashboard:read',
            'reports/exports/low-stock.pdf dashboard:read',
            'reports/exports/no-cost.pdf dashboard:read',
            'reports/exports/sales-daily.pdf dashboard:read',
            'reports/exports/sales-monthly.pdf dashboard:read',
        ]);
    });

    it.each(RUTAS_PDF.map((r) => [r.ruta]))(
        'admin: %s responde lo mismo desde api y desde reportsPdf',
        async (ruta) => {
            const { desdeApi, desdePdf } = await enAmbas(ruta, {
                token: 'token-admin',
                origin: ORIGEN_PERMITIDO,
            });

            expect(desdePdf.status).toBe(200);
            expect(desdePdf.tipo).toMatch(/^application\/pdf/);
            expect(desdePdf.disposicion).toMatch(/^attachment; filename=".+\.pdf"$/);
            expect(desdePdf.exponer).toBe('Content-Disposition');
            expect(desdePdf.origen).toBe(ORIGEN_PERMITIDO);
            expect(desdePdf.cuerpo.equals(PDF_FALSO)).toBe(true);
            // Mientras el panel viejo siga en producción, `api` responde igual.
            expect(desdeApi).toEqual(desdePdf);
        },
    );

    it.each(RUTAS_PDF.map((r) => [r.ruta]))(
        'sin dashboard ni accounting (cajero): %s es 403 en las dos',
        async (ruta) => {
            const { desdeApi, desdePdf } = await enAmbas(ruta, { token: 'token-cajero' });

            expect(desdePdf.status).toBe(403);
            expect(JSON.parse(desdePdf.cuerpo.toString()).error.code).toBe('FORBIDDEN');
            expect(desdeApi).toEqual(desdePdf);
        },
    );

    it.each(RUTAS_PDF.map((r) => [r.ruta, r.area]))(
        'solo dashboard:read: %s (%s) responde igual en las dos',
        async (ruta, area) => {
            const { desdeApi, desdePdf } = await enAmbas(ruta, { token: 'token-analista' });

            expect(desdePdf.status).toBe(area === 'dashboard' ? 200 : 403);
            expect(desdeApi).toEqual(desdePdf);
        },
    );

    it('aplica el authorize del reporte: libro de controlados solo admin o gerente', async () => {
        const ruta = '/v1/reports/exports/libro-controlados?format=pdf';
        const { desdeApi, desdePdf } = await enAmbas(ruta, { token: 'token-analista' });

        expect(desdePdf.status).toBe(403);
        expect(desdeApi).toEqual(desdePdf);
    });

    it('sin token o con token vencido: el mismo 401 que api', async () => {
        const ruta = '/v1/reports/exports/inventory.pdf';
        for (const token of [undefined, 'token-vencido']) {
            const { desdeApi, desdePdf } = await enAmbas(ruta, { token });

            expect(desdePdf.status).toBe(401);
            expect(JSON.parse(desdePdf.cuerpo.toString()).error.code).toBe('UNAUTHORIZED');
            expect(desdeApi).toEqual(desdePdf);
        }
    });

    it('valida los parámetros con los mismos esquemas', async () => {
        const ruta = '/v1/reports/exports/sales-monthly.pdf?month=2026-13';
        const { desdeApi, desdePdf } = await enAmbas(ruta, { token: 'token-admin' });

        expect(desdePdf.status).toBe(400);
        expect(desdeApi).toEqual(desdePdf);
    });
});

describe('reportsPdf: CORS igual que api', () => {
    it('rechaza un origen fuera de CORS_ORIGINS igual que api', async () => {
        const ruta = '/v1/reports/exports/inventory.pdf';
        const { desdeApi, desdePdf } = await enAmbas(ruta, {
            token: 'token-admin',
            origin: ORIGEN_AJENO,
        });

        expect(desdePdf.status).not.toBe(200);
        expect(desdePdf.origen).toBeNull();
        expect(desdePdf.status).toBe(desdeApi.status);
        expect(desdePdf.origen).toBe(desdeApi.origen);
    });

    it('contesta el preflight de un origen permitido igual que api', async () => {
        const ruta = '/v1/reports/exports/inventory.pdf';
        const { desdeApi, desdePdf } = await enAmbas(ruta, {
            origin: ORIGEN_PERMITIDO,
            method: 'OPTIONS',
        });

        expect(desdePdf.status).toBe(204);
        expect(desdePdf.origen).toBe(ORIGEN_PERMITIDO);
        expect(desdeApi.status).toBe(desdePdf.status);
        expect(desdeApi.origen).toBe(desdePdf.origen);
    });
});

describe('XLSX y CSV siguen en api', () => {
    it('GET /reports/exports/ventas?format=xlsx responde en api y no en reportsPdf', async () => {
        const ruta = `/v1/reports/exports/ventas?format=xlsx&month=${MES}`;
        const { desdeApi, desdePdf } = await enAmbas(ruta, { token: 'token-admin' });

        expect(desdeApi.status).toBe(200);
        expect(desdeApi.tipo).toMatch(/spreadsheetml/);
        expect(desdePdf.status).toBe(400);
        expect(JSON.parse(desdePdf.cuerpo.toString()).error.message).toMatch(/solo genera PDF/);
    });

    it('reportsPdf no expone el resto de la API', async () => {
        const res = await pedir(pdf.base, '/v1/products', { token: 'token-admin' });
        expect(res.status).toBe(404);
        const csv = await pedir(pdf.base, '/v1/accounting/exports/payables.csv', {
            token: 'token-admin',
        });
        expect(csv.status).toBe(404);
    });
});

describe('exportación de las funciones', () => {
    it('reportsPdf: 1 GiB, 120 s, us-central1, una petición por instancia; api igual', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const funciones = require('../src/index') as Record<string, {
            __endpoint: Record<string, unknown>;
        }>;

        expect(funciones.reportsPdf.__endpoint).toEqual(expect.objectContaining({
            region: ['us-central1'],
            availableMemoryMb: 1024,
            timeoutSeconds: 120,
            concurrency: 1,
        }));
        expect(funciones.api.__endpoint).toEqual(expect.objectContaining({
            region: ['us-central1'],
            availableMemoryMb: 512,
            timeoutSeconds: 60,
        }));
    });

    it('index.ts carga la app de reportsPdf con import diferido (frío de api)', () => {
        const fuente = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');
        expect(fuente).not.toMatch(/^import .*reports-pdf/m);
        expect(fuente).toMatch(/await import\('\.\/reports-pdf-app'\)/);
    });
});
