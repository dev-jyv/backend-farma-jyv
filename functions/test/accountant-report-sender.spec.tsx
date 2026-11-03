import { renderToStaticMarkup } from 'react-dom/server';
import { AccountantReportEmail } from '../src/emails/accountant-report.email';
import { createUserProfile } from '../src/repositories/users.repository';
import * as rolesRepo from '../src/repositories/roles.repository';
import { SYSTEM_ROLE_DEFINITIONS } from '../src/constants/permissions';
import {
    resolveAccountantRecipients,
    sendAccountantMonthlyReport,
} from '../src/services/accountant-report-sender.service';
import { exportReportBundle } from '../src/services/report-export/export-report';
import { sendReportEmail } from '../src/services/email.service';
import { getPreviousMonth } from '../src/services/sales-reports.service';
import { RolePermission } from '../src/types';
import { db } from '../src/utils/firestore';

/**
 * SPEC 45: el correo mensual del contador. Resend y la generación de archivos se
 * simulan —lo que se prueba es a quién le llega, cuántos adjuntos lleva y qué
 * pasa cuando un envío falla—; los usuarios y roles son reales en el emulador.
 */

const mockSend = jest.fn();

jest.mock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));
// `@react-email/render` hace un `await import()` que el runtime CJS de Jest no
// resuelve; la plantilla se prueba aparte con react-dom/server.
jest.mock('@react-email/render', () => ({ render: jest.fn(async () => '<html></html>') }));
jest.mock('../src/services/report-export/export-report', () => ({
    exportReportBundle: jest.fn(),
}));

const bundle = exportReportBundle as jest.MockedFunction<typeof exportReportBundle>;

const envOriginal = { ...process.env };

beforeAll(() => {
    process.env.RESEND_API_KEY = 're_prueba';
    process.env.REPORTS_EMAIL_FROM = 'reportes@farmajyv.test';
    process.env.REPORTS_EMAIL_TO = 'dueno@farmajyv.test';
});

afterAll(() => {
    process.env = envOriginal;
});

/** Cada caso arma sus propios destinatarios: la base solo se limpia por archivo. */
const borrarUsuarios = async () => {
    const snapshot = await db().collection('users').get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
};

beforeEach(async () => {
    await borrarUsuarios();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    bundle.mockReset();
    bundle.mockImplementation(async (input) => ({
        files: input.formats.map((format) => ({
            body: Buffer.from(`${input.report}-${input.query.scope ?? ''}-${format}`),
            contentType: 'application/octet-stream',
            fileName: `ignorado.${format}`,
        })),
        preview: {
            columns: [],
            rows: [],
            totals: (input.report === 'facturas'
                ? { total: 800 }
                : { amount: input.query.scope === 'pharmacy' ? 1500.5 : 300 }) as
                Record<string, number>,
            truncated: false,
            rowCount: input.report === 'facturas' ? 4 : 10,
        },
    }));
});

const rol = async (slug: string, permissions: RolePermission[], isActive = true) =>
    rolesRepo.createRole({
        name: slug,
        slug,
        permissions,
        permissionsVersion: 1,
        isSystem: false,
        isActive,
    });

let n = 0;
const usuario = async (
    roleId: string,
    opciones: { isActive?: boolean; monthlyReportEmail?: boolean; email?: string } = {},
) => {
    n += 1;
    const email = opciones.email ?? `u${n}@farmajyv.test`;
    await createUserProfile(`uid-${n}`, {
        email,
        displayName: `Usuario ${n}`,
        roleId,
        permissionsVersion: 1,
        isActive: opciones.isActive ?? true,
        monthlyReportEmail: opciones.monthlyReportEmail,
    });
    return email;
};

const destinatariosEnviados = () =>
    mockSend.mock.calls.map(([payload]) => payload.to as string[]);

describe('sendAccountantMonthlyReport', () => {
    let contadorId: string;
    let cajeroId: string;
    let adminId: string;
    let inactivoId: string;

    beforeAll(async () => {
        contadorId = (await rol('accountant', SYSTEM_ROLE_DEFINITIONS.accountant.permissions)).id;
        cajeroId = (await rol('cashier', SYSTEM_ROLE_DEFINITIONS.cashier.permissions)).id;
        adminId = (await rol('admin', [])).id;
        inactivoId = (await rol('auxiliar-viejo', [{ area: 'reportDownloads', level: 'read' }],
            false)).id;
    });

    it('sin destinatarios no genera archivos ni envía', async () => {
        await usuario(contadorId, { monthlyReportEmail: false });

        const result = await sendAccountantMonthlyReport(2026, 10);

        expect(result).toEqual({ month: '2026-10', recipients: 0, sent: 0, failed: [] });
        expect(bundle).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('un correo por destinatario con 6 adjuntos, ignorando inactivos y roles sin el área',
        async () => {
            const contador = await usuario(contadorId, {
                monthlyReportEmail: true,
                email: 'contador@farmajyv.test',
            });
            const dueno = await usuario(adminId, {
                monthlyReportEmail: true,
                email: 'admin@farmajyv.test',
            });
            await usuario(contadorId, { monthlyReportEmail: true, isActive: false });
            await usuario(cajeroId, { monthlyReportEmail: true });
            await usuario(inactivoId, { monthlyReportEmail: true });
            await usuario('rol-que-no-existe', { monthlyReportEmail: true });

            const result = await sendAccountantMonthlyReport(2026, 10);

            expect(result).toMatchObject({ month: '2026-10', recipients: 2, sent: 2, failed: [] });
            expect(destinatariosEnviados().sort()).toEqual([[dueno], [contador]].sort());

            for (const [payload] of mockSend.mock.calls) {
                // Nunca la lista fija del negocio ni copias entre destinatarios.
                expect(payload.to).toHaveLength(1);
                expect(payload.subject).toBe('Ventas y compras — octubre de 2026');
                expect(payload.attachments.map((a: { filename: string }) => a.filename))
                    .toEqual([
                        'ventas-farmacia-2026-10.pdf',
                        'ventas-farmacia-2026-10.xlsx',
                        'ventas-consultorio-2026-10.pdf',
                        'ventas-consultorio-2026-10.xlsx',
                        'compras-2026-10.pdf',
                        'compras-2026-10.xlsx',
                    ]);
                expect(payload.attachments[0].content.toString()).toBe('ventas-pharmacy-pdf');
            }

            // Los archivos se generan una vez, no una por destinatario.
            expect(bundle).toHaveBeenCalledTimes(3);
            expect(bundle.mock.calls.map(([input]) => ({
                report: input.report,
                query: input.query,
                roleSlug: input.roleSlug,
                generatedBy: input.generatedBy,
                formats: input.formats,
            }))).toEqual([
                {
                    report: 'ventas',
                    query: { month: '2026-10', scope: 'pharmacy' },
                    roleSlug: 'admin',
                    generatedBy: 'Sistema',
                    formats: ['pdf', 'xlsx'],
                },
                {
                    report: 'ventas',
                    query: { month: '2026-10', scope: 'clinic' },
                    roleSlug: 'admin',
                    generatedBy: 'Sistema',
                    formats: ['pdf', 'xlsx'],
                },
                {
                    report: 'facturas',
                    query: { month: '2026-10' },
                    roleSlug: 'admin',
                    generatedBy: 'Sistema',
                    formats: ['pdf', 'xlsx'],
                },
            ]);
        });

    it('un envío que falla no detiene a los demás y el job termina con error', async () => {
        await usuario(contadorId, { monthlyReportEmail: true, email: 'a@farmajyv.test' });
        await usuario(contadorId, { monthlyReportEmail: true, email: 'b@farmajyv.test' });
        mockSend.mockImplementation(async (payload: { to: string[] }) =>
            payload.to[0] === 'a@farmajyv.test'
                ? { data: null, error: { message: 'dominio no verificado' } }
                : { data: { id: 'ok' }, error: null });
        const consola = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(sendAccountantMonthlyReport(2026, 10)).rejects.toMatchObject({
            message: expect.stringContaining('a@farmajyv.test'),
            result: {
                recipients: 2,
                sent: 1,
                failed: [{ email: 'a@farmajyv.test', reason: expect.stringContaining('dominio') }],
            },
        });
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(consola).toHaveBeenCalled();
        consola.mockRestore();
    });

    it('sin periodo toma el mes anterior', async () => {
        await usuario(contadorId, { monthlyReportEmail: true });
        const { year, month } = getPreviousMonth();
        const result = await sendAccountantMonthlyReport();
        expect(result.month).toBe(`${year}-${String(month).padStart(2, '0')}`);
    });
});

describe('sendReportEmail', () => {
    it('rechaza una lista de destinatarios vacía en vez de mandar a la lista fija', async () => {
        await expect(sendReportEmail({ to: [], subject: 's', react: <p /> }))
            .rejects.toThrow('vacía');
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('sin `to` va a REPORTS_EMAIL_TO con su adjunto, como siempre', async () => {
        await sendReportEmail({
            subject: 's',
            react: <p />,
            attachment: { filename: 'a.pdf', content: Buffer.from('x') },
        });
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
            to: ['dueno@farmajyv.test'],
            attachments: [{ filename: 'a.pdf', content: Buffer.from('x') }],
        }));
    });
});

describe('resolveAccountantRecipients', () => {
    it('un contador movido a otro rol deja de recibirlo', async () => {
        const cajero = await rol('cajero-x', [{ area: 'pos', level: 'write' }]);
        await usuario(cajero.id, { monthlyReportEmail: true });
        expect(await resolveAccountantRecipients()).toEqual([]);
    });
});

describe('AccountantReportEmail', () => {
    const html = renderToStaticMarkup(
        <AccountantReportEmail
            recipientName="Contadora"
            periodLabel="octubre de 2026"
            summary={[
                { label: 'Ventas de farmacia', count: 10, amount: 1500.5 },
                { label: 'Compras (facturas de proveedores)', count: 1, amount: 800 },
            ]}
            attachments={[
                { filename: 'ventas-farmacia-2026-10.pdf', label: 'Ventas de farmacia' },
                { filename: 'ventas-farmacia-2026-10.xlsx', label: 'Ventas de farmacia' },
            ]}
        />,
    );

    it('muestra totales, conteos y la lista de adjuntos', () => {
        expect(html).toContain('octubre de 2026');
        expect(html).toContain('Hola, Contadora');
        expect(html).toContain('$1,500.50');
        expect(html).toContain('10 operaciones');
        expect(html).toContain('1 operación');
        expect(html).toContain('ventas-farmacia-2026-10.xlsx');
        expect(html).toContain('Excel');
    });
});
