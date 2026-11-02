import { defineSecret } from 'firebase-functions/params';

/**
 * Credenciales del backend en Cloud Secret Manager (SPEC 35).
 *
 * Cada secreto se declara **una sola vez** aquí y se lee con `.value()` en
 * tiempo de ejecución, nunca al cargar el módulo (ver `readSecret` en
 * `config/env.ts`). Firebase monta el valor como variable de entorno al arrancar
 * la instancia, así que leerlo no cuesta una llamada a Secret Manager por
 * petición.
 *
 * Una función solo ve los secretos que declara en su opción `secrets`: `api`
 * monta `API_SECRETS`, y las programadas que mandan correo solo
 * `EMAIL_SECRETS`. Agregar aquí un secreto nuevo exige crearlo en cada
 * proyecto antes de desplegar (RUNBOOK «Secretos»), y `scripts/check-env-split.mjs` /
 * `scripts/check-secrets.mjs` toman la lista de este archivo.
 *
 * En el emulador los valores salen de `functions/.secret.local` y en
 * `npm run dev` de `.env.local` / `.secret.local`; en Jest, de `process.env`.
 */
export const MERCADOPAGO_ACCESS_TOKEN = defineSecret('MERCADOPAGO_ACCESS_TOKEN');
export const MERCADOPAGO_WEBHOOK_SECRET = defineSecret('MERCADOPAGO_WEBHOOK_SECRET');
export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
export const R2_ACCESS_KEY_ID = defineSecret('R2_ACCESS_KEY_ID');
export const R2_SECRET_ACCESS_KEY = defineSecret('R2_SECRET_ACCESS_KEY');
export const MIGRATE_SECRET = defineSecret('MIGRATE_SECRET');
export const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');

/** Todo lo que puede tocar la API: cobros, webhook, correo manual, R2, rutas internas, IA. */
export const API_SECRETS = [
    MERCADOPAGO_ACCESS_TOKEN,
    MERCADOPAGO_WEBHOOK_SECRET,
    RESEND_API_KEY,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    MIGRATE_SECRET,
    OPENROUTER_API_KEY,
];

/** Las funciones programadas que solo mandan correo por Resend. */
export const EMAIL_SECRETS = [RESEND_API_KEY];
