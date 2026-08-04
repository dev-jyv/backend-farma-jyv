import * as admin from 'firebase-admin';

/**
 * Cierra el cliente de Firestore al terminar cada suite. Sin esto Jest reporta
 * "did not exit" y las llamadas en vuelo revientan con "Transaction is invalid or
 * closed" / "require after teardown" al tumbarse el entorno.
 */
afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app?.delete()));
});
