import * as admin from 'firebase-admin';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'farma-jyv-test';

if (!admin.apps.length) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
}

// Las suites escriben y leen en el mismo proceso: sin esto el snapshot de
// catálogo devolvería datos de antes de la escritura.
process.env.CATALOG_SNAPSHOT_TTL_MS = '0';
