// Garantiza `functions/.secret.local` con una línea por cada secreto de
// src/config/secrets.ts, para que el emulador arranque sin Secret Manager.
//
// El emulador de Functions busca en Secret Manager (proyecto `demo-farmajyv`,
// que no existe) todo secreto que `.secret.local` no defina con valor no vacío:
// cada worker que arranca lo intenta, falla y llena la consola de errores. Así
// que aquí se completa lo que falte, sin tocar lo que el desarrollador ya puso:
//
// - si `.env.local` trae ese nombre con valor (configuraciones anteriores a
//   SPEC 35, p. ej. `MIGRATE_SECRET=local-dev-secret`), se copia ese valor;
// - si no, se escribe `" "`: un blanco entre comillas que el emulador toma por
//   valor (no sale a buscarlo) y el backend trata como "no configurado"
//   (`readSecret` recorta), así que la ruta responde el mismo error controlado
//   que antes. R2 sin llaves sigue mandando las facturas a `uploads/`.
//
// Solo imprime NOMBRES. `.secret.local` está en `.gitignore` (`*.local`) y en el
// `ignore` de firebase.json, así que nunca se versiona ni se despliega.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { functionsDir, parseEnv, readSecretNames } from './secret-names.mjs';

const BLANK = '" "';

const unquote = (value) => {
    const trimmed = value.trim();
    const match = /^(["'])(.*)\1$/s.exec(trimmed);
    return match ? match[2] : trimmed;
};

export const ensureSecretLocal = (dir = functionsDir) => {
    const secretPath = join(dir, '.secret.local');
    const envLocalPath = join(dir, '.env.local');
    const current = existsSync(secretPath) ? readFileSync(secretPath, 'utf8') : '';
    const envLocal = new Map(
        existsSync(envLocalPath) ? parseEnv(readFileSync(envLocalPath, 'utf8')) : [],
    );
    // El emulador toma por definido cualquier valor no vacío, blancos entre
    // comillas incluidos (`" "`), así que solo se completa lo vacío o ausente.
    const defined = new Set(
        parseEnv(current)
            .filter(([, value]) => unquote(value).length > 0)
            .map(([key]) => key),
    );

    // Sin archivo previo se parte de la plantilla versionada (comentarios y el
    // `MIGRATE_SECRET` de juguete), pero lo que traiga `.env.local` gana.
    const examplePath = join(functionsDir, '.secret.local.example');
    const example = !current && existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';
    const exampleValues = new Map(parseEnv(example));
    const base = current || example;

    const added = [];
    const lines = base ? base.replace(/\s*$/, '').split(/\r?\n/) : [
        '# Valores de los secretos para el EMULADOR (SPEC 35). Generado por',
        '# scripts/ensure-secret-local.mjs; edítalo a mano si necesitas un valor.',
        '# `" "` = sin valor: el emulador no lo busca en Secret Manager y el backend',
        '# lo trata como no configurado. Nunca pongas aquí credenciales de producción.',
    ];
    for (const name of readSecretNames()) {
        if (defined.has(name)) continue;
        const fromEnvLocal = envLocal.get(name);
        const fromExample = exampleValues.get(name);
        let value = BLANK;
        if (fromEnvLocal && unquote(fromEnvLocal)) {
            value = fromEnvLocal.trim();
        } else if (fromExample && unquote(fromExample)) {
            value = fromExample.trim();
        }
        // Una línea vacía previa (`NOMBRE=`) se reemplaza en su lugar.
        const index = lines.findIndex((line) => line.trim().startsWith(`${name}=`));
        if (index >= 0) {
            lines[index] = `${name}=${value}`;
        } else {
            lines.push(`${name}=${value}`);
        }
        added.push(name);
    }

    if (added.length) {
        writeFileSync(secretPath, `${lines.join('\n')}\n`, { mode: 0o600 });
        console.log(`functions/.secret.local: completados ${added.join(', ')}`);
    }
    return added;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    ensureSecretLocal(process.argv[2] ?? functionsDir);
}
