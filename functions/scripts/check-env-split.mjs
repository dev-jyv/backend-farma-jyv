#!/usr/bin/env node
// Falla si un `.env` desplegable todavía trae secretos.
//
// 1. Los secretos de Secret Manager (los `defineSecret` de src/config/secrets.ts)
//    no pueden aparecer en NINGÚN `.env` desplegable: ni `functions/.env` ni
//    `functions/.env.<proyecto|alias>`. Ni siquiera vacíos: la función monta el
//    secreto con ese mismo nombre de variable y un `.env` que lo repite choca con
//    él (o lo pisa). Su lugar es Secret Manager (RUNBOOK «Secretos») y, en local,
//    `functions/.secret.local` / `functions/.env.local`.
// 2. `functions/.env` se carga en TODOS los proyectos y en el emulador, así que
//    además no puede traer ninguna `MERCADOPAGO_*` con valor: la cuenta de dev
//    no es la de producción.
//
// `.env.local`, `.secret.local`, `.env.demo-*` (emulador) y las plantillas
// `*.example` no se despliegan y no se revisan.
//
// Solo imprime NOMBRES de variables, nunca valores. Acepta como argumento otro
// directorio a revisar (lo usan las pruebas); por defecto, `functions/`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { functionsDir, parseEnv, readSecretNames } from './secret-names.mjs';

const targetDir = process.argv[2] ? resolve(process.argv[2]) : functionsDir;
const secretNames = new Set(readSecretNames());
const SHARED_ONLY = [/^MERCADOPAGO_/];

const isDeployableEnvFile = (name) =>
    (name === '.env' || name.startsWith('.env.')) &&
    !name.endsWith('.example') &&
    !name.endsWith('.local') &&
    !name.startsWith('.env.demo-');

const files = existsSync(targetDir) ? readdirSync(targetDir).filter(isDeployableEnvFile).sort() : [];

const problems = [];
for (const file of files) {
    const entries = parseEnv(readFileSync(join(targetDir, file), 'utf8'));
    for (const [key, value] of entries) {
        if (secretNames.has(key)) {
            problems.push({ file, key, reason: 'es un secreto de Secret Manager' });
        } else if (
            file === '.env' &&
            value.trim() &&
            SHARED_ONLY.some((re) => re.test(key))
        ) {
            problems.push({ file, key, reason: 'se cargaría en todos los ambientes' });
        }
    }
}

if (problems.length) {
    console.error('Hay secretos en archivos .env que se despliegan:');
    problems.forEach(({ file, key, reason }) => console.error(`  - functions/${file}: ${key} (${reason})`));
    console.error(
        'Los secretos van en Secret Manager (RUNBOOK «Secretos») y, para el emulador o `npm run dev`,\n' +
        'en functions/.secret.local. Las MERCADOPAGO_* no secretas van en .env.<proyecto>.\n' +
        'Borra esas líneas (y los valores viejos) de los .env. Ver docs/AMBIENTES.md.',
    );
    process.exit(1);
}
