import { hasPermission } from '../constants/permissions';
import {
    AccountantReportAttachment,
    AccountantReportEmail,
    AccountantReportSummary,
} from '../emails/accountant-report.email';
import * as rolesRepo from '../repositories/roles.repository';
import { listMonthlyReportEmailProfiles } from '../repositories/users.repository';
import { Role, UserProfile } from '../types';
import { EmailAttachment, sendReportEmail } from './email.service';
import { exportReportBundle } from './report-export/export-report';
import { ExportFormat, ExportQuery } from './report-export/report-definition';
import { getPreviousMonth } from './sales-reports.service';

/**
 * Correo mensual del contador (SPEC 45): el día 1, las ventas de farmacia, las
 * ventas de consultorio y las compras del mes anterior, cada una en PDF y XLSX,
 * más el IVA por producto solo en XLSX (es para capturar la declaración, y su
 * PDF de un renglón por producto sería largo y lanzaría Chromium otra vez).
 *
 * Este módulo arrastra Resend, React Email y Chromium: **solo se importa con
 * `await import()`** desde la función programada y desde el disparo manual. Un
 * import estático lo metería en el arranque en frío de `api`.
 *
 * Va a cada usuario activo con `monthlyReportEmail` cuyo rol concede
 * `reportDownloads:read` (el admin también, por slug), nunca a `REPORTS_EMAIL_TO`:
 * es el correo de una persona, no del negocio. Un correo por destinatario, sin
 * copias, para que nadie vea a quién más le llega.
 */

const PDF_AND_XLSX: readonly ExportFormat[] = ['pdf', 'xlsx'];

/** Quien "genera" los archivos del correo: no hay usuario detrás. */
const GENERATED_BY = 'Sistema';

interface ReportSpec {
    report: string;
    scope?: ExportQuery['scope'];
    /** Nombre del archivo sin periodo ni extensión. */
    baseName: string;
    label: string;
    formats: readonly ExportFormat[];
    /** Columna cuyo total va al cuerpo del correo. */
    amountKey: string;
    /** Texto bajo el renglón del cuerpo; sin él, el conteo de operaciones. */
    detail?: (count: number) => string;
}

const REPORTS: readonly ReportSpec[] = [
    {
        report: 'ventas',
        scope: 'pharmacy',
        baseName: 'ventas-farmacia',
        label: 'Ventas de farmacia',
        formats: PDF_AND_XLSX,
        amountKey: 'amount',
    },
    {
        report: 'ventas',
        scope: 'clinic',
        baseName: 'ventas-consultorio',
        label: 'Ventas de consultorio',
        formats: PDF_AND_XLSX,
        amountKey: 'amount',
    },
    {
        report: 'facturas',
        baseName: 'compras',
        label: 'Compras (facturas de proveedores)',
        formats: PDF_AND_XLSX,
        amountKey: 'total',
    },
    {
        report: 'iva-por-producto',
        baseName: 'iva-por-producto',
        label: 'IVA por producto',
        formats: ['xlsx'],
        // El importe del renglón es el IVA trasladado, no lo cobrado.
        amountKey: 'iva',
        detail: (count) => `IVA trasladado · ${count === 1 ? '1 concepto' : `${count} conceptos`}`,
    },
];

export interface AccountantReportResult {
    /** `YYYY-MM` del periodo enviado. */
    month: string;
    recipients: number;
    sent: number;
    /** Destinatarios a los que no se pudo enviar (correo y motivo). */
    failed: Array<{ email: string; reason: string }>;
}

const grantsReportDownloads = (role: Role | null): boolean =>
    Boolean(role && role.isActive !== false &&
        hasPermission(role.permissions, 'reportDownloads', 'read', role.slug));

/**
 * Destinatarios del mes: una consulta a `users` y una lectura por rol distinto
 * (casi siempre uno). Un contador desactivado o movido a otro rol queda fuera
 * aunque conserve `monthlyReportEmail`.
 */
export const resolveAccountantRecipients = async (): Promise<UserProfile[]> => {
    const profiles = (await listMonthlyReportEmailProfiles())
        .filter((profile) => profile.isActive && Boolean(profile.email));
    const roleIds = [...new Set(profiles.map((profile) => profile.roleId))];
    const roles = new Map(await Promise.all(roleIds.map(
        async (roleId) => [roleId, await rolesRepo.getRoleById(roleId)] as const,
    )));
    return profiles.filter((profile) => grantsReportDownloads(roles.get(profile.roleId) ?? null));
};

const monthLabelFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
});

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const sendAccountantMonthlyReport = async (
    year?: number,
    month?: number,
): Promise<AccountantReportResult> => {
    const period = year && month ? { year, month } : getPreviousMonth();
    const monthKey = `${period.year}-${String(period.month).padStart(2, '0')}`;

    // Antes de generar nada: sin destinatarios no vale la pena lanzar Chromium.
    const recipients = await resolveAccountantRecipients();
    if (recipients.length === 0) {
        console.log(`Correo del contador ${monthKey}: sin destinatarios, no se envía`);
        return { month: monthKey, recipients: 0, sent: 0, failed: [] };
    }

    const attachments: EmailAttachment[] = [];
    const listed: AccountantReportAttachment[] = [];
    const summary: AccountantReportSummary[] = [];
    for (const spec of REPORTS) {
        // Como admin por slug: el sistema genera para quien ya tiene el área, y
        // los cuatro reportes son justo los que `reportDownloads` abre.
        const { files, preview } = await exportReportBundle({
            report: spec.report,
            formats: spec.formats,
            query: { month: monthKey, ...(spec.scope ? { scope: spec.scope } : {}) },
            generatedBy: GENERATED_BY,
            roleSlug: 'admin',
        });
        files.forEach((file, index) => {
            const filename = `${spec.baseName}-${monthKey}.${spec.formats[index]}`;
            attachments.push({ filename, content: file.body });
            listed.push({ filename, label: spec.label });
        });
        summary.push({
            label: spec.label,
            count: preview.rowCount,
            amount: preview.totals[spec.amountKey] ?? 0,
            ...(spec.detail ? { detail: spec.detail(preview.rowCount) } : {}),
        });
    }

    const periodLabel = monthLabelFormatter.format(
        new Date(Date.UTC(period.year, period.month - 1, 15)),
    );
    const failed: AccountantReportResult['failed'] = [];
    for (const recipient of recipients) {
        try {
            await sendReportEmail({
                to: [recipient.email],
                subject: `Ventas, compras e IVA — ${periodLabel}`,
                react: AccountantReportEmail({
                    recipientName: recipient.displayName,
                    periodLabel,
                    summary,
                    attachments: listed,
                }),
                attachments,
            });
        } catch (error) {
            // Uno que falla no deja sin correo a los demás; el job falla al final
            // para que la alerta avise y se reenvíe a mano.
            console.error(
                `Correo del contador ${monthKey}: no se pudo enviar a ${recipient.email}`,
                error,
            );
            failed.push({ email: recipient.email, reason: errorMessage(error) });
        }
    }

    const result: AccountantReportResult = {
        month: monthKey,
        recipients: recipients.length,
        sent: recipients.length - failed.length,
        failed,
    };
    if (failed.length > 0) {
        throw Object.assign(
            new Error(
                `Correo del contador ${monthKey}: falló el envío a ${failed.length} de ` +
                `${recipients.length} destinatarios (${failed.map((f) => f.email).join(', ')})`,
            ),
            { result },
        );
    }
    return result;
};
