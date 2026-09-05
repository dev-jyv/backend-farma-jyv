import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './app';

if (!admin.apps.length) {
    admin.initializeApp();
}

export {
    dailyInventoryAlerts,
    dailySalesReport,
    monthlySalesReport,
} from './schedules/sales-reports.schedule';

let appPromise: ReturnType<typeof createApp> | undefined;

/**
 * El bootstrap de Nest se cachea para que las invocaciones calientes no lo
 * repaguen, pero **el rechazo no se cachea**: si `createApp()` falla (Firestore
 * intermitente, un provider que revienta al inicializar), guardar la promesa
 * rechazada dejaba a esa instancia contestando el mismo error a todas las
 * peticiones siguientes hasta que Cloud Run la reciclara. Al limpiarla, el
 * request siguiente vuelve a intentar el arranque.
 */
const getApp = async (): Promise<Awaited<ReturnType<typeof createApp>>> => {
    if (!appPromise) {
        appPromise = createApp();
    }

    try {
        return await appPromise;
    } catch (error) {
        appPromise = undefined;
        throw error;
    }
};

export const api = onRequest(
    {
        region: 'us-central1',
        memory: '512MiB',
        timeoutSeconds: 60,
    },
    async (req, res) => {
        const app = await getApp();
        app(req, res);
    },
);
