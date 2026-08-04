import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
    sendDailySalesReport,
    sendMonthlySalesReport,
} from '../services/sales-report-sender.service';
import { sendInventoryAlertsReport } from '../services/inventory-alerts-sender.service';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';

const SCHEDULE_OPTIONS = {
    region: 'us-central1',
    timeZone: REPORTS_TIME_ZONE,
    memory: '1GiB',
    timeoutSeconds: 180,
} as const;

export const dailySalesReport = onSchedule(
    { ...SCHEDULE_OPTIONS, schedule: '10 0 * * *' },
    async () => {
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
        const { year, month } = await sendMonthlySalesReport();
        console.log(`Reporte mensual de ventas enviado (${year}-${month})`);
    },
);
