// Utilidades comunes de los scripts de operación (SPEC 31, 32, 34, 42, 43).
//
// Regla de la carpeta: **en seco por defecto**. Sin `--apply` ningún script
// escribe ni lee nada en GCP; solo imprime lo que haría. Los reportes de solo
// lectura (reports.mjs) sí consultan, porque no cambian nada.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Proyectos que nunca pueden ser destino de un import o de datos restaurados. */
export const PROTECTED_PROJECTS = Object.freeze(['farma-jyv', 'farma-jyv-dev']);

export const parseArgs = (argv) => {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const [key, ...rest] = arg.slice(2).split('=');
        if (rest.length) flags[key] = rest.join('=');
        else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
        else flags[key] = true;
    }
    return { positional, flags };
};

/** Valor de `--flag` o de la variable de entorno; error en español si falta. */
export const need = (flags, name, envName, fallback) => {
    const value = flags[name] ?? (envName ? process.env[envName] : undefined) ?? fallback;
    if (value === undefined || value === true || value === '') {
        throw new Error(`Falta --${name}${envName ? ` (o ${envName})` : ''}`);
    }
    return String(value);
};

export const optional = (flags, name, envName, fallback) => {
    const value = flags[name] ?? (envName ? process.env[envName] : undefined);
    return value === undefined || value === true || value === '' ? fallback : String(value);
};

export const list = (value) =>
    String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

/**
 * Sustituye `{{VAR}}` (texto, escapado para JSON) y `{{=VAR}}` (número crudo) y
 * valida que el resultado sea JSON. Una variable sin valor es un error: una
 * política creada con un hueco vacío falla en silencio.
 */
export const render = (template, vars) => {
    const output = template.replace(/\{\{(=?)([A-Z0-9_]+)\}\}/g, (_match, raw, key) => {
        if (vars[key] === undefined || vars[key] === null) {
            throw new Error(`Variable sin valor en la plantilla: ${key}`);
        }
        const value = String(vars[key]);
        if (raw) {
            if (!/^-?\d+(\.\d+)?$/.test(value)) {
                throw new Error(`${key} debe ser numérico (recibido "${value}")`);
            }
            return value;
        }
        return JSON.stringify(value).slice(1, -1);
    });
    return JSON.parse(output);
};

export const loadDef = (relativePath, vars = {}) =>
    render(readFileSync(join(OPS_DIR, 'defs', relativePath), 'utf8'), vars);

export const loadJson = (relativePath) =>
    JSON.parse(readFileSync(join(OPS_DIR, relativePath), 'utf8'));

/** Cliente REST de Google con el token de `gcloud`. */
export const createGcpClient = ({ apply, allowReads = apply, quotaProject, log = console.log }) => {
    let token;
    const accessToken = () => {
        token ??= execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
        return token;
    };

    const request = async (method, url, body) => {
        if (method === 'GET' ? !allowReads : !apply) {
            throw new Error(`Interno: ${method} ${url} en modo en seco`);
        }
        const response = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${accessToken()}`,
                'Content-Type': 'application/json',
                ...(quotaProject ? { 'x-goog-user-project': quotaProject } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        const json = text ? JSON.parse(text) : {};
        if (response.status === 404 && method === 'GET') return null;
        if (!response.ok) {
            const error = new Error(
                `${method} ${url} → ${response.status}: ${json.error?.message ?? text}`,
            );
            error.status = response.status;
            throw error;
        }
        return json;
    };

    return {
        apply,
        log,
        get: (url) => request('GET', url),
        post: (url, body) => request('POST', url, body ?? {}),
        patch: (url, body) => request('PATCH', url, body),
        put: (url, body) => request('PUT', url, body),
        delete: (url) => request('DELETE', url),
    };
};

/**
 * Crear o actualizar un recurso identificado por nombre visible. En seco imprime
 * el cuerpo y devuelve un nombre de marcador, para que los pasos siguientes
 * (p. ej. la política que referencia el uptime check) también se impriman.
 */
export const upsert = async (client, { kind, label, body, find, create, update }) => {
    if (!client.apply) {
        client.log(`\n[en seco] ${kind} «${label}»: crear o actualizar con`);
        client.log(JSON.stringify(body, null, 2));
        return { name: '(se asigna al aplicar)', displayName: body.displayName ?? label, dryRun: true };
    }
    const existing = await find();
    if (existing) {
        const result = await update(existing);
        client.log(`✓ ${kind} «${label}» actualizado: ${result?.name ?? existing.name}`);
        return result ?? existing;
    }
    const result = await create();
    client.log(`✓ ${kind} «${label}» creado: ${result?.name}`);
    return result;
};

/** Ejecuta un comando de gcloud, o lo imprime en seco. */
export const gcloud = (apply, args, { log = console.log, allowFailure = false } = {}) => {
    const printable = ['gcloud', ...args].map((arg) => (/\s/.test(arg) ? `'${arg}'` : arg)).join(' ');
    if (!apply) {
        log(`[en seco] ${printable}`);
        return '';
    }
    log(`$ ${printable}`);
    try {
        return execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (error) {
        if (allowFailure) return null;
        throw error;
    }
};

/** Lectura con gcloud (sin efectos); en seco devuelve el marcador. */
export const gcloudRead = (apply, args, placeholder) =>
    apply
        ? execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
        : placeholder;

export const runMain = (main) => {
    main(parseArgs(process.argv.slice(2))).catch((error) => {
        console.error(`\n✗ ${error.message}`);
        process.exit(1);
    });
};
