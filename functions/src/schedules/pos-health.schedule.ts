import { onSchedule } from 'firebase-functions/v2/scheduler';
import { EMAIL_SECRETS } from '../config/secrets';
import { APP_TIME_ZONE } from '../utils/timezone';
import { monitoredJob } from './scheduled-job';

/**
 * Revisión horaria de cajas en silencio (SPEC 44): avisa por correo de cada
 * caja que tenía turno abierto en su último reporte y lleva más de 2 h sin
 * reportar. Un correo por caída: el aviso se marca en el snapshot
 * (`silenceAlertedAt`) y solo un reporte nuevo de la caja lo limpia.
 *
 * Lee solo los snapshots de `posDiagnostics` (una consulta), nunca ventas.
 * El servicio se importa **dentro** del handler: `index.ts` reexporta este
 * módulo y un import estático cargaría Resend y React Email en el arranque en
 * frío de `api`. Sin PDF ni Puppeteer, así que 256 MiB.
 *
 * Corre las 24 h a propósito: una caja que se queda con turno abierto de noche
 * es justo el caso que se quiere ver, y una apagada sin turno no alerta.
 */
export const hourlyPosSilenceCheck = onSchedule(
    {
        region: 'us-central1',
        timeZone: APP_TIME_ZONE,
        memory: '256MiB',
        timeoutSeconds: 120,
        schedule: '0 * * * *',
        // Solo Resend: el correo de caja en silencio (SPEC 35).
        secrets: EMAIL_SECRETS,
    },
    // Log estructurado `scheduled_job.finished` para las alertas de SPEC 32.
    monitoredJob('hourlyPosSilenceCheck', async () => {
        const { checkSilentDevices } = await import(
            '../services/pos-health-alerts-sender.service'
        );
        const { checked, alerted, failed } = await checkSilentDevices();
        console.log(
            `Revisión de cajas en silencio: ${checked} sin reportar en 2 h, ` +
                `${alerted.length} avisadas, ${failed.length} con envío fallido`,
            { alerted, failed },
        );
        return { checked, alerted: alerted.length, failed: failed.length };
    }),
);
