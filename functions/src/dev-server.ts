import * as admin from 'firebase-admin';
import { createApp } from './app';

if (!admin.apps.length) {
    admin.initializeApp();
}

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
    console.log(`FarmaJyV API local: http://localhost:${port}/v1/health`);
});
