import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { EMAIL_SECRETS, MIGRATE_SECRET } from '../config/secrets';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';
import { AppError, badRequest } from '../utils/errors';
import { assertMigrateSecret } from '../utils/migrate-secret';
import { monitoredJob } from './scheduled-job';

/**
 * Correo mensual del contador (SPEC 45): el día 1 a las 00:40, después de los
 * reportes de ventas (00:10 y 00:20) para no lanzar Chromium en paralelo con ellos.
 *
 * 1 GiB y 300 s porque genera seis archivos —tres PDF con Chromium— en una sola
 * corrida. El sender se importa **dentro** del handler: `index.ts` reexporta este
 * módulo, y un import estático cargaría Resend, React Email y Chromium en cada
 * arranque en frío de `api`.
 *
 * Sin `retryCount`: reintentar volvería a mandar el correo a quienes ya lo
 * recibieron. Si falla, la alerta avisa y se reenvía con `accountantReportTrigger`.
 */
export const monthlyAccountantReport = onSchedule(
    {
        region: 'us-central1',
        timeZone: REPORTS_TIME_ZONE,
        memory: '1GiB',
        timeoutSeconds: 300,
        secrets: EMAIL_SECRETS,
        schedule: '40 0 1 * *',
    },
    monitoredJob('monthlyAccountantReport', async () => {
        const { sendAccountantMonthlyReport } = await import(
            '../services/accountant-report-sender.service'
        );
        const { month, recipients, sent } = await sendAccountantMonthlyReport();
        console.log(
            recipients > 0
                ? `Correo del contador enviado (${month}): ${sent} de ${recipients}`
                : `Correo del contador (${month}): sin destinatarios`,
        );
    }),
);

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const firstValue = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

/**
 * Disparo manual del correo del contador: `POST ?month=YYYY-MM` con
 * `x-migrate-secret`; sin `month`, el mes anterior como la programada. Reenvía a
 * **todos** los destinatarios.
 *
 * Es una función aparte y no una ruta de `api` porque hace el mismo trabajo que
 * la programada —tres PDF con Chromium— y en los 512 MiB / 60 s de `api` la
 * instancia se caía con un `Internal Server Error` sin cuerpo. Mismos 1 GiB y
 * 300 s; `maxInstances: 1` y `concurrency: 1` para que dos disparos seguidos no
 * se repartan la memoria ni manden el correo dos veces en paralelo.
 */
export const accountantReportTrigger = onRequest(
    {
        region: 'us-central1',
        memory: '1GiB',
        timeoutSeconds: 300,
        concurrency: 1,
        maxInstances: 1,
        secrets: [...EMAIL_SECRETS, MIGRATE_SECRET],
    },
    async (req, res) => {
        try {
            if (req.method !== 'POST') {
                throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Usa POST');
            }
            assertMigrateSecret(firstValue(req.get('x-migrate-secret')));
            const month = firstValue(req.query.month);
            if (month !== undefined && !MONTH_PATTERN.test(month)) {
                throw badRequest('El mes debe tener formato YYYY-MM');
            }

            const { sendAccountantMonthlyReport } = await import(
                '../services/accountant-report-sender.service'
            );
            // `{ month, recipients, sent, failed }`; si algún envío falla, el sender lanza.
            const result = month
                ? await sendAccountantMonthlyReport(
                    Number(month.slice(0, 4)),
                    Number(month.slice(5, 7)),
                )
                : await sendAccountantMonthlyReport();
            res.status(200).json({ data: result });
        } catch (error) {
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    error: { code: error.code, message: error.message },
                });
                return;
            }
            console.error('accountantReportTrigger falló', error);
            res.status(500).json({
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'No se pudo enviar el correo del contador',
                },
            });
        }
    },
);
