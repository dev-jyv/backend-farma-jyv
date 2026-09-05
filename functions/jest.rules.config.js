/**
 * Configuración aparte para las pruebas de `firestore.rules`.
 *
 * No pueden vivir en `jest.config.js` porque esa suite arranca el emulador desde
 * `functions/`, donde no se ve el `firebase.json` de la raíz: el emulador queda
 * con reglas abiertas y estas pruebas pasarían sin ejercer nada. El script
 * `test:rules` del package.json raíz levanta el emulador desde la raíz.
 *
 * Tampoco carga `test/setup-env.ts` ni `test/teardown-admin.ts`: aquí no se usa
 * `firebase-admin` (que se salta las reglas por diseño), sino el SDK cliente.
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: __dirname,
    testMatch: ['<rootDir>/test-rules/**/*.spec.ts'],
    testTimeout: 30000,
    maxWorkers: 1,
};
