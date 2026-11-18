import { getApps, initializeApp } from 'firebase-admin/app';
import { createApp } from './app';

if (!getApps().length) {
    initializeApp();
}

const port = Number(process.env.PORT ?? 3000);

createApp().then((app) => {
    app.listen(port, () => {
        console.log(`FarmaJyV API local: http://localhost:${port}/v1/health`);
    });
});
