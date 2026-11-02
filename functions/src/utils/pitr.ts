/**
 * Reglas puras de la recuperación por PITR (SPEC 31, RUNBOOK §4).
 *
 * Firestore conserva versiones de cada documento durante 7 días con PITR activo:
 * en la última hora, a cualquier microsegundo; antes de eso, solo a minutos
 * enteros. Validar aquí evita que el script lance la lectura y Firestore la
 * rechace a mitad de la recuperación.
 */

export const PITR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Interpreta y valida la marca de tiempo; devuelve el error en español o la fecha. */
export const parsePitrReadTime = (raw: string, now: Date = new Date()): Date => {
    // Sin zona explícita la fecha dependería del equipo de quien la escribe: una
    // recuperación a la hora equivocada reescribe el documento con otra versión.
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
        throw new Error(
            `--read-time necesita zona explícita (Z o -06:00): "${raw}" es ambiguo`,
        );
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`--read-time no es una fecha válida: "${raw}"`);
    }
    const age = now.getTime() - date.getTime();
    if (age < 0) {
        throw new Error('--read-time está en el futuro');
    }
    if (age > PITR_WINDOW_MS) {
        throw new Error(
            '--read-time es anterior a la ventana de PITR (7 días): usar el export ' +
                'del bucket externo (RUNBOOK §4)',
        );
    }
    if (age > ONE_HOUR_MS && date.getTime() % 60_000 !== 0) {
        throw new Error(
            'Más de una hora atrás, PITR solo lee a minutos enteros: ' +
                'usar una marca terminada en :00 segundos',
        );
    }
    return date;
};

/** `sales/abc` o `customers/x/notes/y`: número par de segmentos, sin vacíos. */
export const parseDocPath = (raw: string): string => {
    const path = raw.trim().replace(/^\/+|\/+$/g, '');
    const segments = path.split('/');
    if (!path || segments.length % 2 !== 0 || segments.some((segment) => !segment)) {
        throw new Error(`Ruta de documento inválida: "${raw}" (se espera colección/id)`);
    }
    return path;
};

export type PitrDocState =
    | { kind: 'unchanged' }
    | { kind: 'changed'; fields: string[] }
    | { kind: 'deleted_since' }
    | { kind: 'created_since' }
    | { kind: 'absent' };

/**
 * Forma comparable de un valor de Firestore. Una `DocumentReference` lleva dentro
 * la instancia del cliente (circular para `JSON.stringify`) y un `Timestamp` debe
 * compararse por segundos y nanos, así que los dos se reducen a texto primero.
 */
const normalize = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(normalize);
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.path === 'string' && 'firestore' in candidate) {
        return `ref:${candidate.path}`;
    }
    if (typeof candidate.seconds === 'number' && typeof candidate.nanoseconds === 'number') {
        return `ts:${candidate.seconds}.${candidate.nanoseconds}`;
    }
    return Object.fromEntries(
        Object.keys(candidate)
            .sort()
            .map((key) => [key, normalize(candidate[key])]),
    );
};

const stable = (value: unknown): string => JSON.stringify(normalize(value)) ?? 'undefined';

/** Compara la versión a `readTime` con la actual, campo por campo de primer nivel. */
export const comparePitrVersions = (
    past: Record<string, unknown> | undefined,
    current: Record<string, unknown> | undefined,
): PitrDocState => {
    if (!past && !current) return { kind: 'absent' };
    if (past && !current) return { kind: 'deleted_since' };
    if (!past && current) return { kind: 'created_since' };

    const keys = new Set([...Object.keys(past!), ...Object.keys(current!)]);
    const fields = [...keys]
        .filter((key) => stable(past![key]) !== stable(current![key]))
        .sort();
    return fields.length ? { kind: 'changed', fields } : { kind: 'unchanged' };
};
