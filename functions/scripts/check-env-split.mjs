#!/usr/bin/env node
// Falla si `functions/.env` todavía trae secretos.
//
// Firebase carga `.env` en TODOS los proyectos y también en el emulador, así que
// un secreto de producción ahí se desplegaría a `farma-jyv-dev` y el emulador
// podría cobrar, mandar correo o subir archivos reales. Los secretos van en
// `.env.farma-jyv` (prod), `.env.farma-jyv-dev` (dev) o `.env.local` (emulador).
//
// Solo lee NOMBRES de variables con valor no vacío; nunca imprime valores.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEYS = [
    /^MERCADOPAGO_/,
    /^RESEND_API_KEY$/,
    /^R2_ACCESS_KEY_ID$/,
    /^R2_SECRET_ACCESS_KEY$/,
    /^MIGRATE_SECRET$/,
    /^OPENROUTER_API_KEY$/,
];

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (!existsSync(envPath)) process.exit(0);

const offending = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=', 2))
    .filter(([key, value]) => value && value.trim() && SECRET_KEYS.some((re) => re.test(key.trim())))
    .map(([key]) => key.trim());

if (offending.length) {
    console.error('functions/.env contiene secretos que Firebase cargaría en todos los ambientes:');
    offending.forEach((key) => console.error(`  - ${key}`));
    console.error('Muévelos a functions/.env.farma-jyv (prod). Ver docs/AMBIENTES.md.');
    process.exit(1);
}
