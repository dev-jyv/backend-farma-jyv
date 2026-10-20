import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';

/**
 * Compara `dailyStats` contra las ventas de los últimos 7 días a las 07:10 y
 * registra una alerta (log ERROR) por cada día con diferencia. El servicio se
 * importa dentro del handler por la misma razón que en `sales-reports.schedule.ts`.
 */
export const dailyStatsIntegrityCheck = onSchedule(
    {
        region: 'us-central1',
        timeZone: REPORTS_TIME_ZONE,
        memory: '256MiB',
        timeoutSeconds: 120,
        schedule: '10 7 * * *',
    },
    async () => {
        const { checkDailyStatsIntegrity } = await import('../services/daily-stats.service');
        await checkDailyStatsIntegrity(7);
    },
);
