import { onSchedule } from 'firebase-functions/v2/scheduler';
import { EMAIL_SECRETS } from '../config/secrets';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';
import { monitoredJob } from './scheduled-job';

/**
 * Mantenimiento de promociones a las 07:05, justo después de las alertas de
 * inventario (07:00): da de baja las vencidas, avisa su desempeño y las que
 * terminan hoy, a tiempo de extenderlas antes de que abra la farmacia.
 *
 * El servicio se importa **dentro** del handler por la misma razón que en
 * `sales-reports.schedule.ts`: `index.ts` reexporta este módulo y un import
 * estático cargaría Resend y React Email en el arranque en frío de `api`.
 * Sin PDF ni Puppeteer, así que memoria baja.
 */
export const dailyPromotionsMaintenance = onSchedule(
    {
        region: 'us-central1',
        timeZone: REPORTS_TIME_ZONE,
        memory: '256MiB',
        timeoutSeconds: 120,
        schedule: '5 7 * * *',
        // Solo Resend: el correo de desempeño y de las que terminan hoy.
        secrets: EMAIL_SECRETS,
    },
    monitoredJob('dailyPromotionsMaintenance', async () => {
        const { sendPromotionsMaintenanceReport } = await import(
            '../services/promotion-alerts-sender.service'
        );
        const { sent, result } = await sendPromotionsMaintenanceReport();
        console.log(
            `Mantenimiento de promociones: ${result.closed.length} cerradas, ` +
                `${result.endingSoon.length} por terminar` +
                (sent ? ' (correo enviado)' : ' (sin correo)'),
        );
    }),
);
