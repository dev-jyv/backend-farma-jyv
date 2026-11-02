#!/usr/bin/env node
// Simulacro mensual de restauración de Firestore (SPEC 43, RUNBOOK §4).
//
// Importa el export más reciente **del bucket externo** en la base (default)
// del proyecto aislado de respaldos, compara conteos contra producción a la
// hora del export y borra la base restaurada. Nunca importa en farma-jyv ni en
// farma-jyv-dev: el export trae pacientes y expedientes (NOM-004).
//
//   node scripts/ops/restore-drill.mjs <paso> --project <respaldos> --bucket <bucket-externo> [--apply]
//
// Pasos, en orden: preflight → import → verify → cleanup. `latest` solo muestra
// qué export se usaría. En seco por defecto, igual que el resto de scripts/ops.
import { createGcpClient, gcloud, gcloudRead, need, optional, runMain } from './lib/cli.mjs';
import {
    DRILL_COLLECTIONS,
    REQUIRED_FIELDS,
    assertDrillTarget,
    exportTimeOf,
    localDayBefore,
    pickLatestExport,
    prodReadTimeFor,
} from './lib/drill.mjs';

const FIRESTORE = 'https://firestore.googleapis.com/v1';

const countQuery = (collection, readTime) => ({
    structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: collection }] },
        aggregations: [{ alias: 'n', count: {} }],
    },
    ...(readTime ? { readTime: readTime.toISOString() } : {}),
});

const countIn = async (client, project, collection, readTime) => {
    const [row] = await client.post(
        `${FIRESTORE}/projects/${project}/databases/(default)/documents:runAggregationQuery`,
        countQuery(collection, readTime),
    );
    return Number(row?.result?.aggregateFields?.n?.integerValue ?? 0);
};

const collectionIds = async (client, project) =>
    (await client.post(
        `${FIRESTORE}/projects/${project}/databases/(default)/documents:listCollectionIds`,
        { pageSize: 50 },
    ))?.collectionIds ?? [];

const firstDocOfDay = async (client, project, collection, field, from, to) => {
    const [row] = await client.post(
        `${FIRESTORE}/projects/${project}/databases/(default)/documents:runQuery`,
        {
            structuredQuery: {
                from: [{ collectionId: collection }],
                where: {
                    compositeFilter: {
                        op: 'AND',
                        filters: [
                            { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: from.toISOString() } } },
                            { fieldFilter: { field: { fieldPath: field }, op: 'LESS_THAN', value: { timestampValue: to.toISOString() } } },
                        ],
                    },
                },
                orderBy: [{ field: { fieldPath: field }, direction: 'DESCENDING' }],
                limit: 1,
            },
        },
    );
    return row?.document ?? null;
};

const listExportObjects = (apply, bucket) =>
    gcloudRead(apply, ['storage', 'ls', '--recursive', `gs://${bucket}/firestore-backups/`], '')
        .split('\n')
        .filter(Boolean);

const steps = {
    latest({ apply, bucket }) {
        if (!apply) {
            console.log(`[en seco] gcloud storage ls --recursive gs://${bucket}/firestore-backups/`);
            console.log('  → el export más reciente con .overall_export_metadata');
            return null;
        }
        const { latest, skipped } = pickLatestExport(listExportObjects(true, bucket));
        if (!latest) throw new Error(`No hay exports completos en gs://${bucket}/firestore-backups/`);
        console.log(`Export a usar: ${latest}`);
        for (const folder of skipped) console.log(`  hueco: ${folder} está incompleto (anotar en el registro)`);
        const age = Date.now() - (exportTimeOf(latest)?.getTime() ?? 0);
        if (age > 26 * 3_600_000) {
            console.log('  aviso: el export más reciente tiene más de 26 h (anotar el hueco)');
        }
        return latest;
    },

    async preflight({ apply, project, sourceProject, bucket, client }) {
        const location = gcloudRead(apply, ['firestore', 'databases', 'describe', '--database=(default)',
            `--project=${sourceProject}`, '--format=value(locationId)'], `<ubicación de ${sourceProject}>`);
        const existing = apply
            ? gcloud(true, ['firestore', 'databases', 'describe', '--database=(default)',
                `--project=${project}`, '--format=value(locationId)'], { allowFailure: true })
            : null;
        if (!existing) {
            // Misma región que producción: un import entre regiones falla.
            gcloud(apply, ['firestore', 'databases', 'create', `--location=${location}`,
                '--type=firestore-native', `--project=${project}`]);
        }
        // Solo lectura del agente de Firestore de este proyecto sobre el bucket
        // externo; sin ella el import falla con PERMISSION_DENIED (edge case).
        const number = gcloudRead(apply, ['projects', 'describe', project,
            '--format=value(projectNumber)'], `<número de ${project}>`);
        gcloud(apply, ['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`,
            `--member=serviceAccount:service-${number}@gcp-sa-firestore.iam.gserviceaccount.com`,
            '--role=roles/storage.objectViewer', '--format=none']);
        if (!existing) return;
        if (existing.trim() !== location) {
            throw new Error(`La base de ${project} está en ${existing.trim()}, producción en ${location}`);
        }
        // Edge case: un simulacro interrumpido antes del borrado. Nunca importar
        // encima de datos de pacientes de otro mes.
        const leftovers = await collectionIds(client, project);
        if (leftovers.length) {
            throw new Error(`La base de ${project} no está vacía (${leftovers.join(', ')}): correr cleanup primero`);
        }
        console.log(`✓ ${project}: base (default) vacía en ${location}`);
    },

    async import(context) {
        const { apply, project, bucket } = context;
        await steps.preflight(context);
        const folder = optional(context.flags, 'export', 'DRILL_EXPORT') ?? steps.latest(context) ??
            `gs://${bucket}/firestore-backups/<export más reciente>/`;
        const started = Date.now();
        gcloud(apply, ['firestore', 'import', folder.replace(/\/$/, ''), `--project=${project}`]);
        if (apply) {
            const minutes = ((Date.now() - started) / 60_000).toFixed(1);
            console.log(`\n✓ Import terminado en ${minutes} min desde ${folder}: anotar en el registro.`);
        }
    },

    async verify({ apply, project, sourceProject, client, flags }) {
        const folder = optional(flags, 'export', 'DRILL_EXPORT');
        if (!apply) {
            console.log(`[en seco] count() de ${DRILL_COLLECTIONS.join(', ')} en ${project} y en ${sourceProject} a la hora del export (PITR)`);
            console.log('[en seco] una venta y un corte del día del export, con sus campos');
            return;
        }
        if (!folder) throw new Error('Pasa --export gs://…/firestore-backups/<carpeta>/ (el que se importó)');
        const exportTime = exportTimeOf(folder);
        const readTime = prodReadTimeFor(exportTime);
        console.log(readTime
            ? `Producción se cuenta a ${readTime.toISOString()} (PITR, hora del export).`
            : 'Export de hace más de 7 días: producción se cuenta HOY; explicar la diferencia en el registro.');
        console.log('\n| Colección | Restaurado | Producción | Diferencia |\n|---|---:|---:|---:|');
        let mismatches = 0;
        for (const collection of DRILL_COLLECTIONS) {
            const restored = await countIn(client, project, collection);
            const prod = await countIn(client, sourceProject, collection, readTime);
            if (restored !== prod) mismatches += 1;
            console.log(`| ${collection} | ${restored} | ${prod} | ${restored - prod} |`);
        }

        const { start: dayStart, end: dayEnd } = localDayBefore(exportTime);
        for (const [collection, field] of [['sales', 'createdAt'], ['cashSessions', 'openedAt']]) {
            const doc = await firstDocOfDay(client, project, collection, field, dayStart, dayEnd);
            if (!doc) {
                console.log(`\n${collection}: sin documentos el ${dayStart.toISOString().slice(0, 10)}; revisar uno anterior en consola.`);
                continue;
            }
            const missing = REQUIRED_FIELDS[collection].filter((key) => !(key in (doc.fields ?? {})));
            console.log(`\n${collection}: ${doc.name.split('/').pop()} — ${Object.keys(doc.fields ?? {}).length} campos` +
                (missing.length ? `; FALTAN ${missing.join(', ')}` : '; campos completos'));
        }
        console.log(mismatches
            ? `\n✗ ${mismatches} colección(es) con diferencia: registrarla y abrir un issue antes de dar el simulacro por bueno.`
            : '\n✓ Conteos iguales a producción.');
    },

    async cleanup({ apply, project, client }) {
        // Se borra la base, nunca el bucket: el bucket es el respaldo.
        gcloud(apply, ['firestore', 'databases', 'delete', '--database=(default)', `--project=${project}`,
            '--quiet'], { allowFailure: true });
        if (!apply) return;
        const still = gcloud(true, ['firestore', 'databases', 'describe', '--database=(default)',
            `--project=${project}`, '--format=value(name)'], { allowFailure: true });
        if (still) {
            const leftovers = await collectionIds(client, project);
            if (leftovers.length) throw new Error(`La base sigue con datos: ${leftovers.join(', ')}`);
        }
        console.log(`✓ ${project}: base restaurada borrada. Anotarlo en el registro.`);
    },
};

runMain(async ({ positional, flags }) => {
    const [step] = positional;
    if (!steps[step]) throw new Error(`Paso desconocido "${step ?? ''}". Usa: ${Object.keys(steps).join(', ')}`);
    const sourceProject = optional(flags, 'source-project', 'SOURCE_PROJECT', 'farma-jyv');
    const project = need(flags, 'project', 'BACKUP_PROJECT');
    assertDrillTarget(project, sourceProject);
    const apply = flags.apply === true;
    const context = {
        apply,
        flags,
        project,
        sourceProject,
        bucket: need(flags, 'bucket', 'EXTERNAL_BUCKET'),
        client: createGcpClient({ apply, quotaProject: project }),
    };
    console.log(apply ? `Simulacro, paso "${step}" en ${project}` : `En seco: paso "${step}" (usa --apply)`);
    await steps[step](context);
});
