import * as admin from 'firebase-admin';
import { comparePitrVersions, parseDocPath, parsePitrReadTime } from '../utils/pitr';

/**
 * Recuperación puntual por PITR (SPEC 31, RUNBOOK §4 "Recuperar por PITR").
 *
 * Lee cada documento indicado **tal como estaba** a `--read-time` (dentro de los
 * últimos 7 días) y lo compara con su versión actual. Con `--execute` reescribe
 * la versión pasada encima de la actual, documento por documento, y deja una
 * entrada `maintenance.pitr_restored` en `auditLogs`.
 *
 * No restaura colecciones enteras a propósito: un `set` masivo pisaría las
 * ventas, entradas y cortes legítimos hechos después del error. Se pasan solo los
 * documentos afectados, y quien corre el script decide cuáles son (p. ej. un lote
 * y su producto: `batches/<id>` y `products/<id>` juntos, porque `totalStock` es
 * la suma de los lotes).
 *
 * Uso (credenciales de producción por ADC: `gcloud auth application-default login`):
 *   npm run pitr:restore -- --project farma-jyv --read-time 2026-11-02T15:04:00Z \
 *       --doc products/abc --doc batches/xyz                     # en seco (default)
 *   ... --execute                                               # reescribe
 *   ... --execute --delete-created     # además borra los que no existían entonces
 */

const ACTOR = 'script:pitr-restore';

const argValues = (flag: string): string[] =>
    process.argv.flatMap((arg, index, all) => (arg === flag ? [all[index + 1]] : []))
        .filter((value): value is string => Boolean(value));

const main = async (): Promise<void> => {
    const [project] = argValues('--project');
    const [rawReadTime] = argValues('--read-time');
    const execute = process.argv.includes('--execute');
    const deleteCreated = process.argv.includes('--delete-created');

    if (!project) throw new Error('Falta --project (p. ej. farma-jyv)');
    if (!rawReadTime) {
        throw new Error('Falta --read-time (ISO con zona, p. ej. 2026-11-02T15:04:00Z)');
    }
    if (process.env.FIRESTORE_EMULATOR_HOST) {
        throw new Error('FIRESTORE_EMULATOR_HOST está definido: el emulador no guarda versiones');
    }
    const readTime = parsePitrReadTime(rawReadTime);
    const paths = argValues('--doc').map(parseDocPath);
    if (!paths.length) throw new Error('Pasa al menos un --doc colección/id');

    admin.initializeApp({ projectId: project });
    const { db } = await import('../utils/firestore');
    const firestore = db();
    const refs = paths.map((path) => firestore.doc(path));

    const pastSnaps = await firestore.runTransaction(
        (transaction) => transaction.getAll(...refs),
        { readOnly: true, readTime: admin.firestore.Timestamp.fromDate(readTime) },
    );
    const currentSnaps = await firestore.getAll(...refs);

    const writes: { path: string; data: Record<string, unknown> | null }[] = [];
    console.log(`Proyecto ${project}, versión a ${readTime.toISOString()}:`);
    refs.forEach((ref, index) => {
        const past = pastSnaps[index].data();
        const current = currentSnaps[index].data();
        const state = comparePitrVersions(past, current);
        switch (state.kind) {
        case 'unchanged':
            console.log(`  = ${ref.path}: sin cambios desde entonces`);
            break;
        case 'absent':
            console.log(`  · ${ref.path}: no existía entonces ni ahora`);
            break;
        case 'changed':
            console.log(`  ~ ${ref.path}: cambió ${state.fields.join(', ')}`);
            writes.push({ path: ref.path, data: past! });
            break;
        case 'deleted_since':
            console.log(`  + ${ref.path}: se borró después; se recrea`);
            writes.push({ path: ref.path, data: past! });
            break;
        case 'created_since':
            console.log(
                `  - ${ref.path}: no existía entonces` +
                    (deleteCreated ? '; se borra' : '; se deja (usar --delete-created)'),
            );
            if (deleteCreated) writes.push({ path: ref.path, data: null });
            break;
        }
    });

    if (!execute) {
        console.log(
            `\nEn seco: ${writes.length} documento(s) por reescribir. Repetir con --execute.`,
        );
        return;
    }
    if (!writes.length) {
        console.log('\nNada que reescribir.');
        return;
    }

    // Un lote de Firestore admite 500 escrituras (incluida la de bitácora). Una
    // recuperación más grande ya no es "puntual": usar el export (RUNBOOK §4).
    if (writes.length > 450) {
        throw new Error(`${writes.length} documentos: partir en tandas de hasta 450`);
    }
    const batch = firestore.batch();
    for (const write of writes) {
        const ref = firestore.doc(write.path);
        if (write.data) batch.set(ref, write.data);
        else batch.delete(ref);
    }
    batch.set(firestore.collection('auditLogs').doc(), {
        action: 'maintenance.pitr_restored',
        entity: 'maintenance',
        entityId: `pitr-${readTime.toISOString()}`,
        userId: ACTOR,
        summary: `Recuperación por PITR a ${readTime.toISOString()}`,
        metadata: {
            readTime: readTime.toISOString(),
            restored: writes.filter((write) => write.data).map((write) => write.path),
            deleted: writes.filter((write) => !write.data).map((write) => write.path),
        },
        createdAt: admin.firestore.Timestamp.now(),
    });
    await batch.commit();
    console.log(`\nListo: ${writes.length} documento(s) reescritos y una entrada en auditLogs.`);
};

main().catch((error) => {
    console.error('Falló:', error instanceof Error ? error.message : error);
    process.exit(1);
});
