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

export const api = onRequest(
    {
        region: 'us-central1',
        memory: '512MiB',
        timeoutSeconds: 60,
    },
    async (req, res) => {
        if (!appPromise) {
            appPromise = createApp();
        }
        const app = await appPromise;
        app(req, res);
    },
);
