import * as admin from 'firebase-admin';

/**
 * Aislamiento entre suites.
 *
 * Las 17 suites comparten un único emulador y, sin esto, cada una arrancaba
 * sobre lo que dejaron las anteriores. Eso costaba dos cosas:
 *
 *  1. **Contención.** El emulador de Firestore usa bloqueo *pesimista* (no la
 *     concurrencia optimista de producción), así que con la base cargada dos
 *     transacciones sobre el mismo documento se serializan hasta agotar los
 *     reintentos del SDK y salir con `ABORTED: Transaction lock timeout`. Es lo
 *     que hacía fallar ~1 de cada 4 corridas la prueba de concurrencia de
 *     `sales.spec.ts` —y solo con el suite completo, nunca aislada.
 *  2. **Cobertura a la deriva.** Al variar los datos de partida, variaba qué
 *     ramas se ejecutaban, y la cifra global oscilaba alrededor de un punto
 *     entre corridas.
 *
 * Se limpia **antes** de cada archivo y no después: si una suite falla, sus
 * documentos quedan en el emulador para poder inspeccionarlos.
 */

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'farma-jyv-test';

const clearFirestore = async (): Promise<void> => {
    const url =
        `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}` +
        '/databases/(default)/documents';

    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
        throw new Error(
            `No se pudo limpiar el emulador (${response.status}). ` +
            'Sin limpiar, las suites se contaminan entre sí y la de concurrencia ' +
            'de ventas falla de forma intermitente.',
        );
    }
};

beforeAll(async () => {
    await clearFirestore();
});

/**
 * Cierra el cliente de Firestore al terminar cada suite. Sin esto Jest reporta
 * "did not exit" y las llamadas en vuelo revientan con "Transaction is invalid o
 * closed" / "require after teardown" al tumbarse el entorno.
 */
afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app?.delete()));
});
