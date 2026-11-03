#!/usr/bin/env node
/**
 * Verifica que los casos dorados de los motores copiados sean **idénticos** en
 * cada repo: promociones en backend, admin y POS; cupones (SPEC 47) en backend
 * y POS. Cada repo corre el motor contra su
 * copia del JSON; si las copias divergen, las tres suites pueden pasar en verde
 * y aun así la caja cobrar un centavo distinto de lo que registra el servidor.
 *
 * Compara sha256 byte a byte, no JSON parseado: el archivo se copia, no se
 * regenera, así que cualquier diferencia (hasta de formato) es una copia vieja.
 *
 * Un repo hermano que no está clonado se avisa y no falla: en CI solo existe
 * este repo. Rutas relativas a `functions/`, no al directorio de trabajo.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cada motor copiado con su archivo de casos y los repos hermanos que lo
 * llevan. Los cupones (SPEC 47) solo viven en backend y POS: el admin no cobra.
 */
const engines = [
    {
        name: 'promociones',
        reference: 'test/promotions-engine.cases.json',
        siblings: [
            '../../farma-jyv-admin/src/app/shared/utils/promotions-engine.cases.json',
            '../../farma-jyv-pos/src/app/shared/utils/promotions-engine.cases.json',
        ],
    },
    {
        name: 'cupones',
        reference: 'test/coupons-engine.cases.json',
        siblings: [
            '../../farma-jyv-pos/src/app/shared/utils/coupons-engine.cases.json',
        ],
    },
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const label = (path) => relative(functionsDir, path);

let mismatches = 0;
for (const engine of engines) {
    const reference = resolve(functionsDir, engine.reference);
    if (!existsSync(reference)) {
        console.error(`✗ No existe ${label(reference)}`);
        process.exit(1);
    }

    const expected = sha256(reference);
    console.log(`[${engine.name}] backend  ${expected}  ${label(reference)}`);

    for (const sibling of engine.siblings) {
        const path = resolve(functionsDir, sibling);
        if (!existsSync(path)) {
            console.warn(`⚠ No se encontró ${sibling}; se omite (¿repo no clonado?)`);
            continue;
        }
        const actual = sha256(path);
        const ok = actual === expected;
        console.log(`[${engine.name}] ${ok ? 'igual  ' : 'DISTINTO'} ${actual}  ${sibling}`);
        if (!ok) {
            mismatches += 1;
        }
    }
}

if (mismatches) {
    console.error(
        `✗ ${mismatches} copia(s) de los casos dorados difieren del backend. ` +
            'Copia el mismo archivo a cada repo (no lo regeneres en otro).',
    );
    process.exit(1);
}
console.log('✓ Casos dorados de los motores idénticos');
