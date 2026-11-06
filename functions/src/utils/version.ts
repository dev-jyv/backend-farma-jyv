/**
 * Comparación de versiones `x.y.z` del POS (SPEC 67). Se lee solo el núcleo
 * numérico (`v1.4.0-beta.2` → 1.4.0) y las partes que falten cuentan como 0.
 * Una versión que no se puede leer **no** se marca como vieja: el panel la
 * pintaría en rojo sin que nadie sepa por qué.
 */
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i;

const parse = (value: string | null | undefined): [number, number, number] | null => {
    const match = VERSION.exec((value ?? '').trim());
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
};

/** `true` si `version` es estrictamente menor que `minimum`; `false` si alguna no se lee. */
export const isVersionBelow = (
    version: string | null | undefined,
    minimum: string | null | undefined,
): boolean => {
    const current = parse(version);
    const min = parse(minimum);
    if (!current || !min) {
        return false;
    }
    for (let index = 0; index < 3; index += 1) {
        if (current[index] !== min[index]) {
            return current[index] < min[index];
        }
    }
    return false;
};
