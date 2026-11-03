#!/usr/bin/env node
// Escribe `functions/.env.<proyecto>` en el job de despliegue (SPEC 39).
//
// Esos archivos no se versionan (docs/AMBIENTES.md), así que el pipeline los arma
// desde la variable de GitHub `FUNCTIONS_ENV_FILE` del environment (`dev` o
// `production`): el contenido literal del archivo, una línea `CLAVE=valor` por
// variable. Es una *variable*, no un secreto: GitHub la muestra en claro. Por eso
// este script se niega a escribir cualquiera de las credenciales, que viven en
// Secret Manager (SPEC 35), y se niega a desplegar mientras el código todavía
// las lea de `.env`: un deploy sin ellas dejaría sin cobros con tarjeta, correo
// o facturas a quien lo reciba.
//
// Uso: FUNCTIONS_ENV_FILE="..." node scripts/ci/write-functions-env.mjs <projectId>
// Nunca imprime valores, solo nombres.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Las mismas siete credenciales de SPEC 35 y de `functions/scripts/check-env-split.mjs`.
const SECRET_NAMES = [
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'MIGRATE_SECRET',
    'OPENROUTER_API_KEY',
];
const SECRET_PATTERNS = [/^MERCADOPAGO_/, ...SECRET_NAMES.map((name) => new RegExp(`^${name}$`))];
// `MERCADOPAGO_USER_ID` no es credencial: es el id público de la cuenta.
const NOT_SECRET = new Set(['MERCADOPAGO_USER_ID']);
const ALLOWED_PROJECTS = new Set(['farma-jyv', 'farma-jyv-dev']);

const fail = (message) => {
    console.error(`::error::${message}`);
    process.exit(1);
};

const projectId = process.argv[2];
if (!ALLOWED_PROJECTS.has(projectId)) {
    fail(`Proyecto inválido: "${projectId ?? ''}". Debe ser farma-jyv o farma-jyv-dev.`);
}

const functionsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'functions');

// 1. El código ya debe leer las credenciales de Secret Manager (SPEC 35).
const sources = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry)) sources.push(readFileSync(path, 'utf8'));
    }
};
walk(join(functionsDir, 'src'));
const code = sources.join('\n');
const undeclared = SECRET_NAMES.filter(
    (name) => !new RegExp(`defineSecret\\(\\s*['"\`]${name}['"\`]`).test(code),
);
if (undeclared.length) {
    fail(
        'Estas credenciales todavía no se declaran con defineSecret (SPEC 35): ' +
        `${undeclared.join(', ')}. El pipeline no maneja credenciales en .env; ` +
        'despliega a mano (RUNBOOK §10.5) hasta que SPEC 35 esté en main.',
    );
}

// 2. La variable existe y no trae credenciales.
const content = process.env.FUNCTIONS_ENV_FILE ?? '';
if (!content.trim()) {
    fail(
        'Falta la variable FUNCTIONS_ENV_FILE en el environment de GitHub ' +
        `para ${projectId} (contenido de functions/.env.${projectId}, sin secretos).`,
    );
}

const entries = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
        const eq = line.indexOf('=');
        return { key: (eq === -1 ? line : line.slice(0, eq)).replace(/^export\s+/, '').trim() };
    });

const malformed = entries
    .filter(({ key }) => !/^[A-Z_][A-Z0-9_]*$/.test(key))
    .map(({ key }) => key);
if (malformed.length) {
    fail(`FUNCTIONS_ENV_FILE tiene líneas que no son CLAVE=valor: ${malformed.join(', ')}`);
}

// Rechaza la clave aunque venga vacía: con defineSecret, una variable de entorno
// con el mismo nombre que un secreto hace fallar el deploy.
const leaked = entries
    .filter(({ key }) => !NOT_SECRET.has(key))
    .filter(({ key }) => SECRET_PATTERNS.some((re) => re.test(key)))
    .map(({ key }) => key);
if (leaked.length) {
    fail(
        `FUNCTIONS_ENV_FILE declara credenciales (${leaked.join(', ')}). Van solo en ` +
        'Secret Manager; quítalas de la variable y, si tenían valor, rótalas: las ' +
        'variables de GitHub se ven en claro.',
    );
}

const target = join(functionsDir, `.env.${projectId}`);
writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
console.log(
    `Escrito functions/.env.${projectId} con ${entries.length} variables: ` +
    entries.map(({ key }) => key).join(', '),
);
