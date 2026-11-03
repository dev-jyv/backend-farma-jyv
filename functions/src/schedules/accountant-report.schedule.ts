import { onSchedule } from 'firebase-functions/v2/scheduler';
import { EMAIL_SECRETS } from '../config/secrets';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';
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
 * recibieron. Si falla, la alerta avisa y se reenvía con
 * `POST /v1/internal/reports/accountant`.
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
