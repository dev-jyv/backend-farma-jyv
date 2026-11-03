// Nombres de los secretos de Secret Manager, leídos de `src/config/secrets.ts`.
//
// Ese archivo es la única lista (SPEC 35). Los scripts de este directorio corren
// antes de compilar (`check-env-split` va primero en `emulators` y `deploy:*`),
// así que leen el fuente en vez de importar `lib/`: un secreto nuevo declarado
// con `defineSecret('X')` entra solo en los chequeos, sin una segunda lista que
// se quede atrás.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const functionsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const readSecretNames = () => {
    const source = readFileSync(join(functionsDir, 'src', 'config', 'secrets.ts'), 'utf8');
    const names = [...source.matchAll(/defineSecret\(\s*'([A-Z0-9_]+)'\s*\)/g)].map((m) => m[1]);
    if (!names.length) {
        throw new Error('No se encontró ningún defineSecret en src/config/secrets.ts');
    }
    return [...new Set(names)];
};

/** `KEY=VALUE` por línea; ignora comentarios y líneas sin `=`. Nunca imprime valores. */
export const parseEnv = (text) =>
    text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
            const index = line.indexOf('=');
            return [line.slice(0, index).trim().replace(/^export\s+/, ''), line.slice(index + 1)];
        });
