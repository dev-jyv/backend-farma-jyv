import 'reflect-metadata';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import ExcelJS from 'exceljs';
import { createUserProfile } from '../src/repositories/users.repository';
import * as rolesRepo from '../src/repositories/roles.repository';
import { AppModule } from '../src/app.module';
import { ReportsPdfModule } from '../src/reports-pdf.module';
import { createHttpApp } from '../src/common/http-pipeline';
import { SYSTEM_ROLE_DEFINITIONS, hasPermission } from '../src/constants/permissions';
import { seedSystemRoles } from '../src/services/roles.service';
import { exportReportBundle } from '../src/services/report-export/export-report';
import { RolePermission } from '../src/types';
import { db } from '../src/utils/firestore';

/**
 * SPEC 45: el contador entra a las descargas con `reportDownloads:read` y solo
 * saca ventas de farmacia, ventas de consultorio y compras. Todo pasa por la app
 * HTTP real (guards, pipes, `exportReport`, filtro de errores) contra el emulador;
 * Chromium se sustituye porque no es lo que se prueba.
 */

const PDF_FALSO = Buffer.from('%PDF-1.4 falso');

jest.mock('../src/services/report-pdf.service', () => ({
    ...jest.requireActual('../src/services/report-pdf.service'),
    renderHtmlToPdf: jest.fn(async () => PDF_FALSO),
}));

const MES = '2026-10';

type Perfil = { slug: string; permissions: RolePermission[] };

const PERFILES: Record<string, Perfil> = {
    admin: { slug: 'admin', permissions: [] },
    contador: {
        slug: 'accountant',
        permissions: SYSTEM_ROLE_DEFINITIONS.accountant.permissions,
    },
    gerente: { slug: 'manager', permissions: SYSTEM_ROLE_DEFINITIONS.manager.permissions },
    // Rol personalizado con el área: mismas reglas que el contador (edge case del spec).
    auxiliar: {
        slug: 'auxiliar-contable',
        permissions: [{ area: 'reportDownloads', level: 'read' }],
    },
};

const sesion = Math.floor(Date.now() / 1000);
const tokens = new Map<string, Record<string, unknown>>();

const servir = async (app: express.Application): Promise<{ base: string; server: Server }> => {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, server };
};

let api: { base: string; server: Server };
let pdf: { base: string; server: Server };

beforeAll(async () => {
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

    // Dos facturas de octubre y una de noviembre (fuera del periodo).
    const proveedor = await db().collection('suppliers').add({ name: 'Distribuidora Uno' });
    const factura = (numero: string, iso: string, total: number) => ({
        supplierId: proveedor.id,
        invoiceNumber: numero,
        invoiceDate: Timestamp.fromDate(new Date(iso)),
        totalAmount: total,
        hasInvoice: false,
        createdBy: 'uid-admin',
        createdAt: Timestamp.fromDate(new Date(iso)),
    });
    await db().collection('invoices').add(factura('F-1', '2026-10-05T18:00:00Z', 1000.1));
    await db().collection('invoices').add(factura('F-2', '2026-10-20T18:00:00Z', 250.2));
    await db().collection('invoices').add(factura('F-3', '2026-11-02T18:00:00Z', 999));

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

    api = await servir(await createHttpApp(AppModule));
    pdf = await servir(await createHttpApp(ReportsPdfModule));
});

afterAll(async () => {
    jest.restoreAllMocks();
    await Promise.all([api, pdf].map(({ server }) =>
        new Promise<void>((resolve) => server.close(() => resolve()))));
});

const pedir = async (base: string, ruta: string, quien: string) => {
    const res = await fetch(`${base}${ruta}`, {
        headers: { Authorization: `Bearer token-${quien}` },
    });
    return {
        status: res.status,
        tipo: res.headers.get('content-type'),
        disposicion: res.headers.get('content-disposition'),
        cuerpo: Buffer.from(await res.arrayBuffer()),
    };
};

const PERMITIDOS = [
    `ventas?scope=pharmacy&month=${MES}`,
    `ventas?scope=clinic&month=${MES}`,
    `facturas?month=${MES}`,
    `iva-por-producto?month=${MES}`,
];

describe('rol de sistema accountant', () => {
    it('seedSystemRoles lo crea con solo reportDownloads:read', async () => {
        const { created } = await seedSystemRoles();
        expect(created).toContain('accountant');

        const rol = await rolesRepo.getRoleBySlug('accountant');
        expect(rol).toMatchObject({ name: 'Contador', isSystem: true, isActive: true });
        expect(rol?.permissions).toEqual([{ area: 'reportDownloads', level: 'read' }]);
    });

    it('el gerente no tiene reportDownloads y el admin sí (por slug)', async () => {
        const gerente = await rolesRepo.getRoleBySlug('manager');
        expect(gerente?.permissions.map((p) => p.area)).not.toContain('reportDownloads');
        expect(hasPermission([], 'reportDownloads', 'read', 'admin')).toBe(true);
    });
});

describe('descargas del contador en api', () => {
    it.each(PERMITIDOS.flatMap((ruta) =>
        (['pdf', 'xlsx', 'csv'] as const).map((formato) => [ruta, formato] as const)))(
        '200 en %s como %s',
        async (ruta, formato) => {
            const res = await pedir(
                api.base,
                `/v1/reports/exports/${ruta}&format=${formato}`,
                'contador',
            );
            expect(res.status).toBe(200);
            expect(res.disposicion).toMatch(new RegExp(`\\.${formato}"$`));
        },
    );

    it.each(PERMITIDOS)('200 en %s como json, con la forma de la vista previa', async (ruta) => {
        const res = await pedir(api.base, `/v1/reports/exports/${ruta}&format=json`, 'contador');
        expect(res.status).toBe(200);
        expect(res.tipo).toMatch(/^application\/json/);
        const { data } = JSON.parse(res.cuerpo.toString());
        expect(Object.keys(data).sort()).toEqual(
            ['columns', 'rowCount', 'rows', 'totals', 'truncated'],
        );
        expect(data.columns[0]).toEqual(expect.objectContaining({
            key: expect.any(String),
            label: expect.any(String),
            type: expect.any(String),
        }));
        expect(data.truncated).toBe(false);
    });

    it('json de compras: filas del periodo y totales en pesos', async () => {
        const res = await pedir(
            api.base,
            `/v1/reports/exports/facturas?month=${MES}&format=json`,
            'contador',
        );
        const { data } = JSON.parse(res.cuerpo.toString());
        expect(data.rows.map((row: { number: string }) => row.number)).toEqual(['F-1', 'F-2']);
        expect(data.rowCount).toBe(2);
        expect(data.totals).toEqual({ total: 1250.3 });
    });

    it('el xlsx de compras trae las filas', async () => {
        const res = await pedir(
            api.base,
            `/v1/reports/exports/facturas?month=${MES}&format=xlsx`,
            'contador',
        );
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(res.cuerpo as unknown as ArrayBuffer);
        const valores = libro.worksheets[0].getColumn(3).values.map(String);
        expect(valores).toEqual(expect.arrayContaining(['F-1', 'F-2']));
    });

    it.each([
        ['utilidad', `utilidad?month=${MES}`],
        ['corte-caja', `corte-caja?month=${MES}`],
        ['ventas financial', `ventas?scope=financial&month=${MES}`],
        ['ventas sin scope (agregado)', `ventas?month=${MES}`],
        ['bitácora', `bitacora?month=${MES}`],
    ])('403 en %s, también como json', async (_nombre, ruta) => {
        for (const formato of ['pdf', 'json']) {
            const res = await pedir(
                api.base,
                `/v1/reports/exports/${ruta}&format=${formato}`,
                'contador',
            );
            expect(res.status).toBe(403);
            const { error } = JSON.parse(res.cuerpo.toString());
            expect(error).toEqual({
                code: 'FORBIDDEN',
                message: 'No tienes permiso para este reporte',
            });
        }
    });

    it.each([
        '/v1/reports/sales-summary',
        '/v1/invoices',
        '/v1/reports/exports/sales-monthly.pdf?month=2026-10',
        '/v1/reports/exports/invoices.pdf?month=2026-10',
    ])('403 fuera de las descargas: %s', async (ruta) => {
        const res = await pedir(api.base, ruta, 'contador');
        expect(res.status).toBe(403);
    });

    it('un rol personalizado con reportDownloads sigue las mismas reglas', async () => {
        const ok = await pedir(
            api.base,
            `/v1/reports/exports/ventas?scope=clinic&month=${MES}&format=csv`,
            'auxiliar',
        );
        const no = await pedir(
            api.base,
            `/v1/reports/exports/ventas?scope=financial&month=${MES}&format=csv`,
            'auxiliar',
        );
        expect([ok.status, no.status]).toEqual([200, 403]);
    });
});

describe('quién más descarga', () => {
    it.each(PERMITIDOS)('el gerente sigue sin exportes: %s es 403', async (ruta) => {
        const res = await pedir(api.base, `/v1/reports/exports/${ruta}&format=csv`, 'gerente');
        expect(res.status).toBe(403);
    });

    it.each([
        `ventas?scope=financial&month=${MES}&format=csv`,
        `utilidad?month=${MES}&format=xlsx`,
        `corte-caja?month=${MES}&format=pdf`,
        `facturas?month=${MES}&format=json`,
    ])('el admin descarga todo como hoy: %s', async (ruta) => {
        const res = await pedir(api.base, `/v1/reports/exports/${ruta}`, 'admin');
        expect(res.status).toBe(200);
    });
});

describe('descargas del contador en reportsPdf', () => {
    it.each(PERMITIDOS)('200 en %s como pdf', async (ruta) => {
        const res = await pedir(pdf.base, `/v1/reports/exports/${ruta}&format=pdf`, 'contador');
        expect(res.status).toBe(200);
        expect(res.cuerpo.equals(PDF_FALSO)).toBe(true);
    });

    it('403 en utilidad y en ventas financial: la regla vive en exportReport', async () => {
        for (const ruta of [`utilidad?month=${MES}`, `ventas?scope=financial&month=${MES}`]) {
            const res = await pedir(pdf.base, `/v1/reports/exports/${ruta}`, 'contador');
            expect(res.status).toBe(403);
        }
    });

    it('json no se sirve desde reportsPdf (400)', async () => {
        const res = await pedir(
            pdf.base,
            `/v1/reports/exports/facturas?month=${MES}&format=json`,
            'contador',
        );
        expect(res.status).toBe(400);
    });
});

describe('exportReportBundle', () => {
    it('una carga, varios formatos y los totales del periodo', async () => {
        const { files, preview } = await exportReportBundle({
            report: 'facturas',
            formats: ['pdf', 'xlsx'],
            query: { month: MES },
            generatedBy: 'Sistema',
            roleSlug: 'admin',
        });
        expect(files.map((file) => file.fileName)).toEqual([
            `facturas-${MES}.pdf`,
            `facturas-${MES}.xlsx`,
        ]);
        expect(files[0].body.equals(PDF_FALSO)).toBe(true);
        expect(preview).toMatchObject({ rowCount: 2, totals: { total: 1250.3 } });
    });

    it('aplica la misma autorización que la descarga', async () => {
        await expect(exportReportBundle({
            report: 'utilidad',
            formats: ['pdf'],
            query: { month: MES },
            generatedBy: 'x',
            roleSlug: 'accountant',
            permissions: [{ area: 'reportDownloads', level: 'read' }],
        })).rejects.toMatchObject({ statusCode: 403 });
    });
});
