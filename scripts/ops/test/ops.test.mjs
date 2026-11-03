// Pruebas de scripts/ops (SPEC 31, 32, 34, 42, 43): node --test scripts/ops/test/
//
// No tocan GCP. Las de "en seco" corren los scripts con un PATH sin gcloud: si
// un script intentara llamar a gcloud sin --apply, fallaría aquí.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { OPS_DIR, loadDef, loadJson, parseArgs, render } from '../lib/cli.mjs';
import {
    analyzeColdStarts,
    coldStartFilter,
    formatColdStartTable,
    parseLatencySeconds,
    percentile,
} from '../lib/cold-start.mjs';
import {
    DRILL_COLLECTIONS,
    assertDrillTarget,
    exportTimeOf,
    localDayBefore,
    pickLatestExport,
    prodReadTimeFor,
} from '../lib/drill.mjs';
import { dailyStoreMax, evaluateInstanceTrigger } from '../lib/instances.mjs';
import {
    calendarDays,
    isStoreDay,
    isStoreTime,
    isStoreTimeByUtcClauses,
    storeHoursPromqlMask,
} from '../lib/store-hours.mjs';

const REPO = join(OPS_DIR, '..', '..');
const SAMPLE_VARS = {
    PROJECT: 'proyecto-x',
    API_HOST: 'api.example.com',
    HEALTH_PATH: '/v1/health',
    UPTIME_TIMEOUT_SECONDS: 30,
    UPTIME_CHECK_ID: 'chk-1',
    JOB: 'dailyFirestoreBackup',
    RETRY_COUNT: 1,
    SEVERITY: 'CRITICAL',
    SCHEDULE: '02:00 diario',
    ACTION: 'Lanzar "export" manual',
    TOPIC: 'farmajyv-transfer-fallos',
    TRANSFER_JOB: 'transferJobs/x',
    TRANSFER_JOB_ID: 'x',
    SOURCE_BUCKET: 'origen',
    DEST_BUCKET: 'destino',
    START_YEAR: 2026,
    START_MONTH: 11,
    START_DAY: 2,
    START_HOUR_UTC: 11,
    PROJECT_NUMBER: '123',
    CURRENCY: 'USD',
    AMOUNT: '5',
    COLD_START_FILTER: 'resource.type="cloud_run_revision"',
};

describe('plantillas', () => {
    it('render escapa texto para JSON y exige números crudos', () => {
        assert.deepEqual(render('{"a":"{{X}}","n":{{=N}}}', { X: 'di "hola"\n', N: 3 }), {
            a: 'di "hola"\n',
            n: 3,
        });
        assert.throws(() => render('{"a":"{{X}}"}', {}), /sin valor.*X/);
        assert.throws(() => render('{"n":{{=N}}}', { N: 'tres' }), /numérico/);
    });

    it('todas las definiciones de defs/ se resuelven a JSON válido', () => {
        const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
        const files = walk(join(OPS_DIR, 'defs')).filter((file) => file.endsWith('.json'));
        assert.ok(files.length >= 10);
        for (const file of files) {
            assert.doesNotThrow(() => loadDef(file.slice(join(OPS_DIR, 'defs').length + 1), SAMPLE_VARS), file);
        }
    });

    it('las políticas filtran por la métrica y las etiquetas que define la métrica de log', () => {
        const metric = loadDef('logging/metric-scheduled-job-runs.json');
        const labels = metric.metricDescriptor.labels.map((label) => label.key).sort();
        assert.deepEqual(labels, Object.keys(metric.labelExtractors).sort());
        assert.match(metric.filter, /scheduled_job\.finished/);

        const failed = loadDef('monitoring/policy-scheduled-job-failed.json', SAMPLE_VARS);
        const { filter, thresholdValue, comparison } = failed.conditions[0].conditionThreshold;
        assert.ok(filter.includes(`logging.googleapis.com/user/${metric.name}`));
        assert.ok(filter.includes('metric.label.function="dailyFirestoreBackup"'));
        assert.ok(filter.includes('metric.label.outcome="failed"'));
        // Un intento fallido con reintento exitoso (1 fallo, retryCount 1) no alerta.
        assert.equal(comparison, 'COMPARISON_GT');
        assert.equal(thresholdValue, 1);

        const absent = loadDef('monitoring/policy-backup-absent.json', SAMPLE_VARS);
        const { query } = absent.conditions[0].conditionPrometheusQueryLanguage;
        assert.ok(query.includes(`logging_googleapis_com:user_${metric.name}`));
        assert.ok(query.includes('function="dailyFirestoreBackup"'));
        assert.ok(query.includes('outcome="succeeded"'));
        assert.ok(query.includes('[26h]'));
    });

    it('el uptime check revisa cada 5 min y la política espera 5 min y 2 regiones', () => {
        const check = loadDef('monitoring/uptime-api-health.json', SAMPLE_VARS);
        assert.equal(check.period, '300s');
        assert.ok(check.selectedRegions.length >= 3);
        const policy = loadDef('monitoring/policy-uptime-api.json', SAMPLE_VARS);
        const condition = policy.conditions[0].conditionThreshold;
        assert.equal(condition.duration, '300s');
        assert.equal(condition.thresholdValue, 1);
        assert.ok(condition.filter.includes('check_id="chk-1"'));
    });

    it('la transferencia nunca sobrescribe ni borra y avisa solo fallos', () => {
        const job = loadDef('storage/transfer-job.json', SAMPLE_VARS);
        const options = job.transferSpec.transferOptions;
        assert.equal(options.overwriteWhen, 'NEVER');
        assert.equal(options.deleteObjectsFromSourceAfterTransfer, false);
        assert.equal(options.deleteObjectsUniqueInSink, false);
        assert.equal(job.transferSpec.gcsDataSource.path, 'firestore-backups/');
        assert.deepEqual(job.notificationConfig.eventTypes.sort(),
            ['TRANSFER_OPERATION_ABORTED', 'TRANSFER_OPERATION_FAILED']);
    });

    it('el presupuesto tiene umbrales de 50, 90 y 100 %', () => {
        const budget = loadDef('billing/budget.json', SAMPLE_VARS);
        assert.deepEqual(budget.thresholdRules.map((rule) => rule.thresholdPercent), [0.5, 0.9, 1]);
        assert.equal(budget.amount.specifiedAmount.units, '5');
    });

    it('scheduled-jobs.json describe cada función con severidad válida', () => {
        const { jobs } = loadJson('scheduled-jobs.json');
        assert.equal(jobs.length, new Set(jobs.map((job) => job.name)).size);
        for (const job of jobs) {
            assert.ok(['CRITICAL', 'ERROR', 'WARNING'].includes(job.severity), job.name);
            assert.ok(Number.isInteger(job.retryCount) && job.retryCount >= 0, job.name);
            assert.ok(job.action && job.schedule, job.name);
        }
        assert.equal(jobs.find((job) => job.name === 'dailyFirestoreBackup').severity, 'CRITICAL');
    });

    it('parseArgs acepta --k v, --k=v y banderas', () => {
        assert.deepEqual(parseArgs(['alerts', '--project', 'p', '--x=1', '--apply']), {
            positional: ['alerts'],
            flags: { project: 'p', x: '1', apply: true },
        });
    });
});

describe('horario de tienda', () => {
    const at = (local) => new Date(`${local}-06:00`);

    it('L–V 09:00–20:00 y sábado 09:00–13:00, domingo y festivos fuera', () => {
        assert.equal(isStoreTime(at('2026-11-02T08:59:00')), false); // lunes
        assert.equal(isStoreTime(at('2026-11-02T09:00:00')), true);
        assert.equal(isStoreTime(at('2026-11-02T14:30:00')), true); // hueco del consultorio sí cuenta
        assert.equal(isStoreTime(at('2026-11-02T19:59:00')), true);
        assert.equal(isStoreTime(at('2026-11-02T20:00:00')), false);
        assert.equal(isStoreTime(at('2026-11-07T12:59:00')), true); // sábado
        assert.equal(isStoreTime(at('2026-11-07T13:00:00')), false);
        assert.equal(isStoreTime(at('2026-11-08T11:00:00')), false); // domingo
        assert.equal(isStoreTime(at('2026-11-16T11:00:00'), new Set(['2026-11-16'])), false);
        assert.equal(isStoreDay('2026-11-08'), false);
        assert.equal(isStoreDay('2026-11-09'), true);
    });

    it('el PromQL del dashboard coincide con el horario minuto a minuto', () => {
        const start = Date.parse('2026-11-01T00:00:00Z');
        for (let minute = 0; minute < 8 * 24 * 60; minute += 1) {
            const date = new Date(start + minute * 60_000);
            assert.equal(isStoreTimeByUtcClauses(date), isStoreTime(date), date.toISOString());
        }
        const dashboard = readFileSync(join(OPS_DIR, 'defs/monitoring/dashboard-api-instances.json'), 'utf8');
        const query = JSON.parse(dashboard).mosaicLayout.tiles[1].widget.xyChart.dataSets[0]
            .timeSeriesQuery.prometheusQuery;
        assert.ok(query.endsWith(`and on() ${storeHoursPromqlMask()}`), query);
    });
});

describe('arranque en frío (SPEC 34)', () => {
    const start = (timestamp, instanceId, reason = 'AUTOSCALING', revision = 'api-00042') => ({
        timestamp,
        textPayload: `Starting new instance. Reason: ${reason} - Instance started.`,
        labels: { instanceId },
        resource: { labels: { revision_name: revision } },
    });
    const request = (timestamp, instanceId, latency, revision = 'api-00042') => ({
        timestamp,
        httpRequest: { latency: `${latency}s` },
        labels: { instanceId },
        resource: { labels: { revision_name: revision } },
    });

    it('toma la primera petición de cada instancia y excluye despliegues, domingos y fuera de horario', () => {
        const entries = [
            // Primera aparición de la revisión: el despliegue (excluido por gracia de 10 min).
            request('2026-11-02T12:00:00Z', 'dep', 9.9),
            start('2026-11-02T12:00:01Z', 'dep'),
            // Lunes 09:30 local: arranque real, latencia 4.2 s (la 2.ª petición no cuenta).
            start('2026-11-02T15:30:00Z', 'i1'),
            request('2026-11-02T15:30:01Z', 'i1', 4.2),
            request('2026-11-02T15:31:00Z', 'i1', 0.1),
            // Lunes 12:00 local: 1.0 s.
            request('2026-11-02T18:00:01Z', 'i2', 1.0),
            start('2026-11-02T18:00:00Z', 'i2'),
            // Arranque por DEPLOYMENT: excluido.
            start('2026-11-03T16:00:00Z', 'i3', 'DEPLOYMENT', 'api-00043'),
            request('2026-11-03T16:00:01Z', 'i3', 8),
            // Lunes 22:00 local: fuera de horario.
            start('2026-11-03T04:00:00Z', 'i4'),
            request('2026-11-03T04:00:01Z', 'i4', 5),
            // Domingo: no cuenta.
            start('2026-11-08T17:00:00Z', 'i5'),
            request('2026-11-08T17:00:01Z', 'i5', 7),
            // Sin petición (instancia que no atendió nada).
            start('2026-11-04T17:00:00Z', 'i6'),
        ];
        const result = analyzeColdStarts(entries, { from: '2026-11-02', days: 14 });
        const monday = result.rows.find((row) => row.ymd === '2026-11-02');
        assert.deepEqual([monday.starts, monday.p50, monday.p95], [2, 1.0, 4.2]);
        assert.equal(result.rows.find((row) => row.ymd === '2026-11-08').counts, false);
        assert.deepEqual(result.excluded, { deployment: 2, offHours: 1, closedDay: 1, noRequest: 1, outOfRange: 0 });
        assert.equal(result.overall.p95, 4.2);
        assert.equal(result.recommendMinInstances, true);
        const table = formatColdStartTable(result);
        assert.match(table, /\| 2026-11-02 \| lun \| 2 \| 1\.00 s \| 4\.20 s \|/);
        assert.match(table, /2026-11-08 \| dom \| cerrado/);
        assert.match(table, /minInstances: 1/);
        assert.equal(result.rows.length, 14);
    });

    it('sin superar 3 s el p95 no recomienda cambiar nada', () => {
        const result = analyzeColdStarts([
            start('2026-11-02T15:30:00Z', 'a'), request('2026-11-02T15:30:01Z', 'a', 2.9),
        ], { from: '2026-11-02', days: 14, deployGraceMinutes: 0 });
        assert.equal(result.recommendMinInstances, false);
        assert.match(formatColdStartTable(result), /no cambiar la configuración/);
    });

    it('percentil por rango más cercano y latencias de Logging', () => {
        assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
        assert.equal(percentile(Array.from({ length: 20 }, (_v, i) => i + 1), 0.95), 19);
        assert.equal(percentile([], 0.95), null);
        assert.equal(parseLatencySeconds('3.250901s'), 3.250901);
        assert.ok(Number.isNaN(parseLatencySeconds(undefined)));
    });

    it('el filtro cubre arranques y peticiones de api', () => {
        const filter = coldStartFilter('farma-jyv', { from: 'A', to: 'B' });
        assert.match(filter, /service_name="api"/);
        assert.match(filter, /varlog%2Fsystem.*Starting new instance/);
        assert.match(filter, /run\.googleapis\.com%2Frequests/);
        assert.match(filter, /timestamp>="A"[\s\S]*timestamp<"B"/);
    });
});

describe('disparador de instancias (SPEC 42)', () => {
    const point = (iso, value) => ({ interval: { endTime: iso }, value: { int64Value: String(value) } });

    it('máximo diario solo en horario de tienda', () => {
        const daily = dailyStoreMax([
            point('2026-11-02T16:00:00Z', 2), // lunes 10:00
            point('2026-11-02T20:00:00Z', 5), // lunes 14:00
            point('2026-11-03T05:00:00Z', 9), // lunes 23:00: fuera de horario
            point('2026-11-08T17:00:00Z', 7), // domingo
        ]);
        assert.deepEqual(daily, [{ ymd: '2026-11-02', max: 5 }]);
    });

    it('7 días de tienda seguidos con más de 3; el domingo no corta ni suma', () => {
        const days = calendarDays('2026-11-02', 14).filter((ymd) => isStoreDay(ymd));
        const above = (ymds) => ymds.map((ymd) => ({ ymd, max: 4 }));
        // lun 2 … sáb 7 (6 días) + lun 9 = 7 días de tienda seguidos.
        const seven = above(days.slice(0, 7));
        assert.equal(evaluateInstanceTrigger(seven, days).triggered, true);
        // Un día en exactamente 3 corta la racha.
        const broken = seven.map((day, index) => (index === 3 ? { ...day, max: 3 } : day));
        assert.equal(evaluateInstanceTrigger(broken, days).triggered, false);
        // Un pico de un día no basta.
        assert.equal(evaluateInstanceTrigger([{ ymd: days[0], max: 12 }], days).longestStreak, 1);
    });
});

describe('simulacro de restauración (SPEC 43)', () => {
    it('nunca importa en producción, dev, demo ni el proyecto origen', () => {
        for (const project of ['farma-jyv', 'farma-jyv-dev', 'demo-farmajyv', 'origen']) {
            assert.throws(() => assertDrillTarget(project, 'origen'), /nunca importa|Falta/);
        }
        assert.throws(() => assertDrillTarget('', 'farma-jyv'), /Falta --project/);
        assert.doesNotThrow(() => assertDrillTarget('farma-jyv-respaldos', 'farma-jyv'));
    });

    it('elige el export completo más reciente y anota los incompletos', () => {
        const base = 'gs://ext/firestore-backups/';
        const { latest, skipped } = pickLatestExport([
            `${base}2026-11-01T08-00-00/2026-11-01T08-00-00.overall_export_metadata`,
            `${base}2026-11-01T08-00-00/all_namespaces/output-0`,
            `${base}2026-11-02T08-00-00/all_namespaces/output-0`,
            'gs://ext/manual/x.overall_export_metadata',
        ]);
        assert.equal(latest, `${base}2026-11-01T08-00-00/`);
        assert.deepEqual(skipped, [`${base}2026-11-02T08-00-00/`]);
        assert.equal(pickLatestExport([]).latest, null);
    });

    it('cuenta producción a la hora del export (minuto entero) dentro de 7 días', () => {
        const exportTime = exportTimeOf('gs://ext/firestore-backups/2026-11-02T08-00-27/');
        assert.equal(exportTime.toISOString(), '2026-11-02T08:00:27.000Z');
        assert.equal(prodReadTimeFor(exportTime, new Date('2026-11-03T00:00:00Z')).toISOString(),
            '2026-11-02T08:00:00.000Z');
        assert.equal(prodReadTimeFor(exportTime, new Date('2026-11-10T00:00:00Z')), null);
        const { start, end } = localDayBefore(exportTime);
        assert.deepEqual([start.toISOString(), end.toISOString()],
            ['2026-11-01T06:00:00.000Z', '2026-11-02T06:00:00.000Z']);
        assert.deepEqual(DRILL_COLLECTIONS, ['sales', 'batches', 'products', 'cashSessions']);
    });
});

describe('en seco no llama a gcloud', () => {
    // PATH sin gcloud: solo node y las utilidades del sistema.
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    delete env.PROJECT;
    const runScript = (command, args) => spawnSync(command, args, { cwd: REPO, env, encoding: 'utf8' });
    const emails = ['--ops-email', 'ops@example.com', '--owner-email', 'owner@example.com'];
    const cases = [
        ['gcp.mjs', ['alerts', '--project', 'farma-jyv', ...emails]],
        ['gcp.mjs', ['budget', '--project', 'farma-jyv', '--billing-account', '000000-000000-000000', ...emails]],
        ['gcp.mjs', ['transfer', '--project', 'farma-jyv-respaldos', '--dest-bucket', 'externo']],
        ['gcp.mjs', ['transfer-alert', '--project', 'farma-jyv-respaldos', ...emails]],
        ['gcp.mjs', ['saved-query', '--project', 'farma-jyv']],
        ['gcp.mjs', ['dashboard', '--project', 'farma-jyv']],
        ...['latest', 'preflight', 'import', 'verify', 'cleanup'].map((step) =>
            ['restore-drill.mjs', [step, '--project', 'farma-jyv-respaldos', '--bucket', 'externo']]),
    ];

    for (const [script, args] of cases) {
        it(`${script} ${args[0]}`, () => {
            const result = runScript(process.execPath, [join(OPS_DIR, script), ...args]);
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.match(result.stdout, /en seco/i);
        });
    }

    it('gcp.mjs alerts imprime la tabla de §7 con las 9 políticas y las 2 existentes', () => {
        const result = runScript(process.execPath, [join(OPS_DIR, 'gcp.mjs'), 'alerts', '--project', 'farma-jyv', ...emails]);
        const policies = result.stdout.match(/\[en seco\] política de alerta/g) ?? [];
        assert.equal(policies.length, 1 + loadJson('scheduled-jobs.json').jobs.length + 1);
        assert.equal((result.stdout.match(/política existente/g) ?? []).length, 2);
    });

    it('los proyectos protegidos se rechazan aun en seco', () => {
        const transfer = runScript(process.execPath,
            [join(OPS_DIR, 'gcp.mjs'), 'transfer', '--project', 'farma-jyv', '--dest-bucket', 'x']);
        assert.notEqual(transfer.status, 0);
        const drill = runScript(process.execPath,
            [join(OPS_DIR, 'restore-drill.mjs'), 'import', '--project', 'farma-jyv-dev', '--bucket', 'x']);
        assert.notEqual(drill.status, 0);
        assert.match(drill.stderr, /nunca importa/);
    });

    it('scripts bash', () => {
        const pitr = runScript('bash', [join(OPS_DIR, '31-pitr.sh')]);
        assert.equal(pitr.status, 0, pitr.stderr);
        assert.match(pitr.stdout, /\[en seco\] gcloud firestore databases update/);
        const project = spawnSync('bash', [join(OPS_DIR, '31-backup-project.sh')], {
            cwd: REPO,
            encoding: 'utf8',
            env: {
                ...env,
                BACKUP_PROJECT: 'farma-jyv-respaldos',
                EXTERNAL_BUCKET: 'externo',
                BILLING_ACCOUNT: '000000-000000-000000',
                OWNER_ACCOUNT: 'owner@example.com',
            },
        });
        assert.equal(project.status, 0, project.stderr);
        assert.match(project.stdout, /--versioning/);
        const protectedRun = spawnSync('bash', [join(OPS_DIR, '31-backup-project.sh')], {
            cwd: REPO,
            encoding: 'utf8',
            env: { ...env, BACKUP_PROJECT: 'farma-jyv', EXTERNAL_BUCKET: 'x', BILLING_ACCOUNT: 'b', OWNER_ACCOUNT: 'o' },
        });
        assert.notEqual(protectedRun.status, 0);
    });
});
