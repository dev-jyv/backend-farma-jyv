import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';

/**
 * Los servicios de envío se importan **dentro** de cada handler, no arriba.
 * `index.ts` reexporta este módulo, así que un import estático aquí también se
 * carga en el arranque en frío de la function `api`, que nunca manda correo:
 * arrastraba Resend, React y React Email por nada. Cada función programada
 * paga solo lo que usa, la primera vez que corre.
 */

const SCHEDULE_OPTIONS = {
    region: 'us-central1',
    timeZone: REPORTS_TIME_ZONE,
    memory: '1GiB',
    timeoutSeconds: 180,
} as const;

export const dailySalesReport = onSchedule(
    { ...SCHEDULE_OPTIONS, schedule: '10 0 * * *' },
    async () => {
        const { sendDailySalesReport } = await import(
            '../services/sales-report-sender.service'
        );
        const { date } = await sendDailySalesReport();
        console.log(`Reporte diario de ventas enviado (${date})`);
    },
);

/**
 * Alertas de inventario a las 07:00: llega cuando la farmacia abre y todavía se
 * puede actuar (retirar lote vencido, pedir al proveedor). No lleva PDF, así que
 * no necesita Puppeteer ni 1GiB.
 */
export const dailyInventoryAlerts = onSchedule(
    {
        region: 'us-central1',
        timeZone: REPORTS_TIME_ZONE,
        memory: '256MiB',
        timeoutSeconds: 120,
        schedule: '0 7 * * *',
    },
    async () => {
        const { sendInventoryAlertsReport } = await import(
            '../services/inventory-alerts-sender.service'
        );
        const { sent, totals } = await sendInventoryAlertsReport();
        console.log(
            sent
                ? `Alertas de inventario enviadas (${JSON.stringify(totals)})`
                : 'Sin alertas de inventario que reportar',
        );
    },
);

export const monthlySalesReport = onSchedule(
    { ...SCHEDULE_OPTIONS, schedule: '20 0 1 * *' },
    async () => {
        const { sendMonthlySalesReport } = await import(
            '../services/sales-report-sender.service'
        );
        const { year, month } = await sendMonthlySalesReport();
        console.log(`Reporte mensual de ventas enviado (${year}-${month})`);
    },
);
