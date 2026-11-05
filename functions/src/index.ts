import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './app';
import { API_SECRETS } from './config/secrets';

if (!admin.apps.length) {
    admin.initializeApp();
}

export {
    dailyInventoryAlerts,
    dailySalesReport,
    monthlySalesReport,
} from './schedules/sales-reports.schedule';
export {
    accountantReportTrigger,
    monthlyAccountantReport,
} from './schedules/accountant-report.schedule';
export { dailyFirestoreBackup } from './schedules/backup.schedule';
export { dailyStatsIntegrityCheck } from './schedules/daily-stats.schedule';
export { dailyPromotionsMaintenance } from './schedules/promotions.schedule';
export { hourlyPosSilenceCheck } from './schedules/pos-health.schedule';

type HttpApp = Awaited<ReturnType<typeof createApp>>;

/**
 * El bootstrap de Nest se cachea para que las invocaciones calientes no lo
 * repaguen, pero **el rechazo no se cachea**: si el arranque falla (Firestore
 * intermitente, un provider que revienta al inicializar), guardar la promesa
 * rechazada dejaba a esa instancia contestando el mismo error a todas las
 * peticiones siguientes hasta que Cloud Run la reciclara. Al limpiarla, el
 * request siguiente vuelve a intentar el arranque.
 */
const cachedBootstrap = (create: () => Promise<HttpApp>): (() => Promise<HttpApp>) => {
    let appPromise: Promise<HttpApp> | undefined;
    return async () => {
        if (!appPromise) {
            appPromise = create();
        }

        try {
            return await appPromise;
        } catch (error) {
            appPromise = undefined;
            throw error;
        }
    };
};

const getApp = cachedBootstrap(createApp);

/**
 * `reports-pdf-app` se importa con `await import()`: `index.ts` se carga en cada
 * instancia de cada función, y un import estático sumaría el módulo de
 * `reportsPdf` al arranque en frío de `api` (SPEC 38: no debe crecer).
 */
const getReportsPdfApp = cachedBootstrap(async () =>
    (await import('./reports-pdf-app')).createReportsPdfApp());

export const api = onRequest(
    {
        region: 'us-central1',
        memory: '512MiB',
        timeoutSeconds: 60,
        // Montados como variables de entorno al arrancar la instancia (SPEC 35).
        secrets: API_SECRETS,
    },
    async (req, res) => {
        const app = await getApp();
        app(req, res);
    },
);

/**
 * PDF con Chromium fuera de `api` (SPEC 38): las 11 rutas `*.pdf` y
 * `/reports/exports/:report?format=pdf`, con la misma configuración HTTP que
 * `api`. 1 GiB y 120 s como los reportes programados; **`concurrency: 1`** para
 * que dos PDF grandes no compartan el GiB de una instancia (Cloud Run levanta
 * otra en su lugar). `maxInstances` acota el gasto si alguien dispara descargas
 * en ráfaga.
 */
export const reportsPdf = onRequest(
    {
        region: 'us-central1',
        memory: '1GiB',
        timeoutSeconds: 120,
        concurrency: 1,
        maxInstances: 5,
    },
    async (req, res) => {
        const app = await getReportsPdfApp();
        app(req, res);
    },
);
