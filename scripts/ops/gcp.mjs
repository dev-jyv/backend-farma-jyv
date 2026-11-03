#!/usr/bin/env node
// Infraestructura declarativa de operación (SPEC 31, 32, 34, 42).
//
// En seco por defecto: sin `--apply` imprime cada recurso tal como lo crearía y
// no toca GCP. Con `--apply` crea o actualiza por nombre visible, así que se
// puede repetir sin duplicar nada. Las definiciones viven en defs/.
//
//   node scripts/ops/gcp.mjs alerts         --project farma-jyv --ops-email a@x --owner-email b@y
//   node scripts/ops/gcp.mjs budget         --project farma-jyv --billing-account 0000-... (+ correos)
//   node scripts/ops/gcp.mjs transfer       --project <respaldos> --dest-bucket <bucket-externo>
//   node scripts/ops/gcp.mjs transfer-alert --project <respaldos> --ops-email a@x --owner-email b@y
//   node scripts/ops/gcp.mjs saved-query    --project farma-jyv
//   node scripts/ops/gcp.mjs dashboard      --project farma-jyv
//
// Detalle y orden de aplicación: RUNBOOK §4 (respaldos) y §7 (alertas).
import {
    PROTECTED_PROJECTS,
    createGcpClient,
    gcloud,
    gcloudRead,
    list,
    loadDef,
    loadJson,
    need,
    optional,
    runMain,
    upsert,
} from './lib/cli.mjs';
import { coldStartFilter } from './lib/cold-start.mjs';

const MONITORING = 'https://monitoring.googleapis.com/v3';
const DASHBOARDS = 'https://monitoring.googleapis.com/v1';
const LOGGING = 'https://logging.googleapis.com/v2';
const TRANSFER = 'https://storagetransfer.googleapis.com/v1';
const BUDGETS = 'https://billingbudgets.googleapis.com/v1';

/** Políticas creadas a mano el 2026-09-17 (RUNBOOK §7); SPEC 32 les agrega el 2.º canal. */
export const EXISTING_PROD_POLICIES = ['15126880163367668267', '206274569130471057'];

/** Destino de la API por proyecto: el uptime check pega a la URL pública. */
export const API_TARGETS = {
    'farma-jyv': { host: 'api-vykfsskx3q-uc.a.run.app', path: '/v1/health' },
    'farma-jyv-dev': { host: 'us-central1-farma-jyv-dev.cloudfunctions.net', path: '/api/v1/health' },
};

export const TRANSFER_DEFAULTS = {
    sourceProject: 'farma-jyv',
    sourceBucket: 'farma-jyv-respaldos-firestore',
    topic: 'farmajyv-transfer-fallos',
    jobId: 'farmajyv-firestore-backups-externo',
    // 05:00 CDMX (UTC−6 fijo desde 2022): tres horas después del export de las
    // 02:00, que solo tarda minutos. Si un día tarda más, lo que falte se copia
    // al día siguiente (overwriteWhen NEVER salta lo ya copiado).
    startHourUtc: 11,
    writerRole: 'farmajyvBackupWriter',
};

const summary = [];
const remember = (resource, trigger) =>
    summary.push({ name: resource.name, displayName: resource.displayName, trigger });

const printSummary = () => {
    if (!summary.length) return;
    console.log('\nPara RUNBOOK §7 (id = último segmento de name):\n');
    console.log('| Política | id | Se dispara con |');
    console.log('|---|---|---|');
    for (const row of summary) {
        const id = String(row.name).startsWith('projects/') ? `\`${row.name.split('/').pop()}\`` : row.name;
        console.log(`| ${row.displayName} | ${id} | ${row.trigger} |`);
    }
};

// --- Canales -----------------------------------------------------------------

const emailChannels = (flags) => [
    { email: need(flags, 'ops-email', 'OPS_EMAIL'), label: 'Alertas FarmaJyV' },
    { email: need(flags, 'owner-email', 'OWNER_EMAIL'), label: 'Dueño FarmaJyV' },
];

/** Busca por correo antes de crear: el canal de 2026-09-17 se reutiliza tal cual. */
const ensureEmailChannels = async (client, project, channels) => {
    let existing;
    const names = [];
    for (const { email, label } of channels) {
        const body = {
            type: 'email',
            displayName: label,
            labels: { email_address: email },
            enabled: true,
        };
        const channel = await upsert(client, {
            kind: 'canal de correo',
            label: `${label} <${email}>`,
            body,
            find: async () => {
                existing ??= (await client.get(
                    `${MONITORING}/projects/${project}/notificationChannels?pageSize=200`,
                ))?.notificationChannels ?? [];
                return existing.find((item) => item.type === 'email' &&
                    item.labels?.email_address?.toLowerCase() === email.toLowerCase());
            },
            create: () => client.post(`${MONITORING}/projects/${project}/notificationChannels`, body),
            update: async (found) => found,
        });
        names.push(channel.name);
    }
    // Si ops y dueño son el mismo correo, es un solo canal: el API de presupuestos
    // rechaza un canal repetido con un 400 sin detalle.
    return [...new Set(names)];
};

// --- Recursos de Monitoring --------------------------------------------------

const upsertPolicy = (client, project, policy) =>
    upsert(client, {
        kind: 'política de alerta',
        label: policy.displayName,
        body: policy,
        find: async () => (await client.get(
            `${MONITORING}/projects/${project}/alertPolicies?pageSize=200`,
        ))?.alertPolicies?.find((item) => item.displayName === policy.displayName),
        create: () => client.post(`${MONITORING}/projects/${project}/alertPolicies`, policy),
        // Sin updateMask: reemplaza la política completa por la del repo.
        update: (found) => client.patch(`${MONITORING}/${found.name}`, { ...policy, name: found.name }),
    });

const upsertUptimeCheck = (client, project, check) =>
    upsert(client, {
        kind: 'uptime check',
        label: check.displayName,
        body: check,
        find: async () => (await client.get(
            `${MONITORING}/projects/${project}/uptimeCheckConfigs?pageSize=100`,
        ))?.uptimeCheckConfigs?.find((item) => item.displayName === check.displayName),
        create: () => client.post(`${MONITORING}/projects/${project}/uptimeCheckConfigs`, check),
        update: (found) => client.patch(
            `${MONITORING}/${found.name}?updateMask=displayName,httpCheck,contentMatchers,` +
                'period,timeout,selectedRegions',
            { ...check, name: found.name },
        ),
    });

const upsertLogMetric = (client, project, metric) =>
    upsert(client, {
        kind: 'métrica basada en log',
        label: metric.name,
        body: metric,
        find: () => client.get(`${LOGGING}/projects/${project}/metrics/${metric.name}`),
        create: () => client.post(`${LOGGING}/projects/${project}/metrics`, metric),
        update: () => client.put(`${LOGGING}/projects/${project}/metrics/${metric.name}`, metric),
    });

/** Agrega canales a una política existente sin tocar sus condiciones. */
const addChannelsToPolicy = async (client, project, policyId, channels) => {
    const name = `projects/${project}/alertPolicies/${policyId}`;
    if (!client.apply) {
        client.log(`\n[en seco] política existente ${name}: agregar canales ${channels.join(', ')}`);
        return;
    }
    const policy = await client.get(`${MONITORING}/${name}`);
    if (!policy) throw new Error(`No existe ${name}: revisar RUNBOOK §7`);
    const merged = [...new Set([...(policy.notificationChannels ?? []), ...channels])];
    await client.patch(`${MONITORING}/${name}?updateMask=notificationChannels`, {
        notificationChannels: merged,
    });
    client.log(`✓ «${policy.displayName}» notifica a ${merged.length} canal(es)`);
    remember(policy, 'existente (sin cambios en su disparador)');
};

// --- Comandos ----------------------------------------------------------------

const assertNotProtected = (project, what) => {
    if (PROTECTED_PROJECTS.includes(project)) {
        throw new Error(`${what} no puede ser ${project}: debe ser el proyecto aislado de respaldos`);
    }
};

const commands = {
    /** SPEC 32 req. 1–4, 6: uptime, fallo por función, ausencia del backup, 2.º canal. */
    async alerts(client, flags) {
        const project = need(flags, 'project', 'PROJECT');
        const target = API_TARGETS[project] ?? {};
        const vars = {
            PROJECT: project,
            API_HOST: need(flags, 'api-host', 'API_HOST', target.host),
            HEALTH_PATH: need(flags, 'health-path', 'HEALTH_PATH', target.path ?? '/v1/health'),
            // Debe superar el peor arranque en frío medido (SPEC 34); máximo 60.
            UPTIME_TIMEOUT_SECONDS: need(flags, 'uptime-timeout', 'UPTIME_TIMEOUT_SECONDS', '30'),
        };
        const channels = await ensureEmailChannels(client, project, emailChannels(flags));
        const withChannels = (policy) => ({ ...policy, notificationChannels: channels });

        await upsertLogMetric(client, project, loadDef('logging/metric-scheduled-job-runs.json'));

        const check = await upsertUptimeCheck(
            client, project, loadDef('monitoring/uptime-api-health.json', vars),
        );
        const uptimePolicy = await upsertPolicy(client, project, withChannels(loadDef(
            'monitoring/policy-uptime-api.json',
            {
                ...vars,
                UPTIME_CHECK_ID: check.dryRun ? '<id del uptime check>' : String(check.name).split('/').pop(),
            },
        )));
        remember(uptimePolicy, '`/v1/health` falla desde ≥ 2 regiones durante 5 min (chequeo cada 5 min)');

        const { jobs } = loadJson('scheduled-jobs.json');
        for (const job of jobs) {
            const policy = await upsertPolicy(client, project, withChannels(loadDef(
                'monitoring/policy-scheduled-job-failed.json',
                {
                    JOB: job.name,
                    RETRY_COUNT: job.retryCount,
                    SEVERITY: job.severity,
                    SCHEDULE: job.schedule,
                    ACTION: job.action,
                },
            )));
            remember(policy, `más de ${job.retryCount} intento(s) fallido(s) de \`${job.name}\` en 1 h`);
        }

        const absent = await upsertPolicy(client, project, withChannels(
            loadDef('monitoring/policy-backup-absent.json', vars),
        ));
        remember(absent, '26 h sin `succeeded` de `dailyFirestoreBackup`');

        const existing = list(optional(
            flags, 'existing-policies', 'EXISTING_POLICIES',
            project === 'farma-jyv' ? EXISTING_PROD_POLICIES.join(',') : '',
        ));
        for (const policyId of existing) {
            await addChannelsToPolicy(client, project, policyId, channels);
        }
    },

    /** SPEC 32 req. 5: presupuesto mensual con umbrales 50/90/100 %. */
    async budget(client, flags) {
        const project = need(flags, 'project', 'PROJECT');
        const billingAccount = need(flags, 'billing-account', 'BILLING_ACCOUNT')
            .replace(/^billingAccounts\//, '');
        const channels = await ensureEmailChannels(client, project, emailChannels(flags));
        const projectNumber = gcloudRead(
            client.apply,
            ['projects', 'describe', project, '--format=value(projectNumber)'],
            `<número de ${project}>`,
        );
        const budget = loadDef('billing/budget.json', {
            PROJECT: project,
            PROJECT_NUMBER: projectNumber,
            // La moneda debe ser la de la cuenta de facturación; si es MXN el
            // API rechaza USD y hay que convertir el monto (RUNBOOK §7).
            CURRENCY: need(flags, 'currency', 'BUDGET_CURRENCY', 'USD'),
            AMOUNT: need(flags, 'amount', 'BUDGET_AMOUNT', '5'),
        });
        budget.notificationsRule.monitoringNotificationChannels = channels;
        const base = `${BUDGETS}/billingAccounts/${billingAccount}/budgets`;
        await upsert(client, {
            kind: 'presupuesto',
            label: budget.displayName,
            body: budget,
            find: async () => (await client.get(`${base}?pageSize=100`))?.budgets
                ?.find((item) => item.displayName === budget.displayName),
            create: () => client.post(base, budget),
            update: (found) => client.patch(
                `${BUDGETS}/${found.name}?updateMask=displayName,budgetFilter,amount,` +
                    'thresholdRules,notificationsRule',
                { ...budget, name: found.name },
            ),
        });
    },

    /** SPEC 31 req. 3–4: copia diaria al bucket externo con permisos mínimos. */
    async transfer(client, flags) {
        const project = need(flags, 'project', 'BACKUP_PROJECT');
        assertNotProtected(project, '--project');
        const sourceProject = optional(flags, 'source-project', 'SOURCE_PROJECT', TRANSFER_DEFAULTS.sourceProject);
        const sourceBucket = optional(flags, 'source-bucket', 'SOURCE_BUCKET', TRANSFER_DEFAULTS.sourceBucket);
        const destBucket = need(flags, 'dest-bucket', 'EXTERNAL_BUCKET');
        const topic = optional(flags, 'topic', 'TRANSFER_TOPIC', TRANSFER_DEFAULTS.topic);
        const jobId = optional(flags, 'job-id', 'TRANSFER_JOB_ID', TRANSFER_DEFAULTS.jobId);
        const startHourUtc = optional(flags, 'start-hour-utc', 'TRANSFER_START_HOUR_UTC',
            String(TRANSFER_DEFAULTS.startHourUtc));
        if (destBucket === sourceBucket) throw new Error('El bucket destino no puede ser el origen');

        // El agente de Storage Transfer es **del proyecto de respaldos**: ninguna
        // cuenta de farma-jyv recibe permisos sobre el destino.
        const agent = client.apply
            ? (await client.get(`${TRANSFER}/googleServiceAccounts/${project}`)).accountEmail
            : `<agente de Storage Transfer de ${project}>`;
        const member = `serviceAccount:${agent}`;
        client.log(`Agente de Storage Transfer: ${agent} (origen ${sourceProject})`);

        // Origen: solo lectura (listar y leer objetos).
        for (const role of ['roles/storage.legacyBucketReader', 'roles/storage.objectViewer']) {
            gcloud(client.apply, ['storage', 'buckets', 'add-iam-policy-binding', `gs://${sourceBucket}`,
                `--member=${member}`, `--role=${role}`, '--format=none']);
        }

        // Destino: rol propio sin storage.objects.delete. Con overwriteWhen NEVER
        // la transferencia nunca sobrescribe, así que no necesita borrar.
        const role = TRANSFER_DEFAULTS.writerRole;
        const permissions = 'storage.buckets.get,storage.objects.create,storage.objects.get,storage.objects.list';
        const roleExists = client.apply &&
            gcloud(true, ['iam', 'roles', 'describe', role, `--project=${project}`, '--format=none'],
                { allowFailure: true }) !== null;
        gcloud(client.apply, ['iam', 'roles', roleExists ? 'update' : 'create', role,
            `--project=${project}`, '--title=FarmaJyV escritor de respaldos (sin borrar)',
            `--permissions=${permissions}`, '--stage=GA', '--quiet', '--format=none']);
        // Un rol propio recién creado tarda en propagarse: el bucket responde 400
        // «does not exist in the resource's hierarchy» durante un minuto o dos.
        const bindWriter = (allowFailure) => gcloud(client.apply, ['storage', 'buckets',
            'add-iam-policy-binding', `gs://${destBucket}`, `--member=${member}`,
            `--role=projects/${project}/roles/${role}`, '--format=none'], { allowFailure });
        let bound = !client.apply || roleExists ? (bindWriter(false), true) : false;
        for (let attempt = 1; !bound && attempt <= 12; attempt += 1) {
            bound = bindWriter(attempt < 12) !== null;
            if (!bound) {
                client.log(`  el rol todavía no se propaga; reintento en 15 s (${attempt}/12)`);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
            }
        }

        // Topic que solo recibe fallos y abortos: cualquier mensaje dispara la alerta.
        const topicExists = client.apply &&
            gcloud(true, ['pubsub', 'topics', 'describe', topic, `--project=${project}`, '--format=none'],
                { allowFailure: true }) !== null;
        if (!topicExists) {
            gcloud(client.apply, ['pubsub', 'topics', 'create', topic, `--project=${project}`]);
        }
        gcloud(client.apply, ['pubsub', 'topics', 'add-iam-policy-binding', topic, `--project=${project}`,
            `--member=${member}`, '--role=roles/pubsub.publisher', '--format=none']);

        const today = new Date();
        const job = loadDef('storage/transfer-job.json', {
            PROJECT: project,
            TRANSFER_JOB_ID: jobId,
            SOURCE_BUCKET: sourceBucket,
            DEST_BUCKET: destBucket,
            TOPIC: topic,
            START_YEAR: today.getUTCFullYear(),
            START_MONTH: today.getUTCMonth() + 1,
            START_DAY: today.getUTCDate(),
            START_HOUR_UTC: startHourUtc,
        });
        await upsert(client, {
            kind: 'job de Storage Transfer',
            label: job.name,
            body: job,
            find: () => client.get(`${TRANSFER}/${job.name}?projectId=${project}`),
            create: () => client.post(`${TRANSFER}/transferJobs`, job),
            update: () => client.patch(`${TRANSFER}/${job.name}`, {
                projectId: project,
                transferJob: job,
                updateTransferJobFieldMask:
                    'description,transferSpec,schedule,notificationConfig,loggingConfig,status',
            }),
        });
    },

    /** SPEC 32 req. 8: aviso al primer fallo del job de transferencia. */
    async 'transfer-alert'(client, flags) {
        const project = need(flags, 'project', 'BACKUP_PROJECT');
        assertNotProtected(project, '--project');
        const channels = await ensureEmailChannels(client, project, emailChannels(flags));
        const policy = await upsertPolicy(client, project, {
            ...loadDef('monitoring/policy-transfer-failed.json', {
                PROJECT: project,
                TOPIC: optional(flags, 'topic', 'TRANSFER_TOPIC', TRANSFER_DEFAULTS.topic),
                TRANSFER_JOB: optional(flags, 'job-id', 'TRANSFER_JOB_ID', TRANSFER_DEFAULTS.jobId),
            }),
            notificationChannels: channels,
        });
        remember(policy, `un mensaje en el topic de fallos del job de Storage Transfer (${project})`);
    },

    /** SPEC 34 req. 1: consulta de Logging guardada de arranques en frío. */
    async 'saved-query'(client, flags) {
        const project = need(flags, 'project', 'PROJECT');
        const filter = coldStartFilter(project);
        const id = 'farmajyv-arranques-en-frio-api';
        const query = loadDef('logging/saved-query-cold-start.json', { COLD_START_FILTER: filter });
        const base = `${LOGGING}/projects/${project}/locations/global/savedQueries`;
        try {
            await upsert(client, {
                kind: 'consulta guardada',
                label: query.displayName,
                body: query,
                find: () => client.get(`${base}/${id}`),
                create: () => client.post(`${base}?savedQueryId=${id}`, query),
                update: () => client.patch(
                    `${base}/${id}?updateMask=displayName,description,loggingQuery`, query,
                ),
            });
        } catch (error) {
            client.log(`\n! No se pudo guardar por API (${error.message}).`);
            client.log('  Abrir el enlace de abajo y usar "Guardar" en el Explorador de registros.');
        }
        client.log('\nEnlace para el RUNBOOK §8:');
        client.log(`https://console.cloud.google.com/logs/query;query=${encodeURIComponent(filter)};duration=P14D?project=${project}`);
    },

    /** SPEC 42 req. 1: gráfico de instancias activas de api en horario de tienda. */
    async dashboard(client, flags) {
        const project = need(flags, 'project', 'PROJECT');
        const dashboard = loadDef('monitoring/dashboard-api-instances.json', { PROJECT: project });
        const result = await upsert(client, {
            kind: 'dashboard',
            label: dashboard.displayName,
            body: dashboard,
            find: async () => (await client.get(`${DASHBOARDS}/projects/${project}/dashboards?pageSize=100`))
                ?.dashboards?.find((item) => item.displayName === dashboard.displayName),
            create: () => client.post(`${DASHBOARDS}/projects/${project}/dashboards`, dashboard),
            update: (found) => client.patch(`${DASHBOARDS}/${found.name}`, {
                ...dashboard, name: found.name, etag: found.etag,
            }),
        });
        if (!result.dryRun) {
            client.log('\nEnlace para el RUNBOOK §9:');
            client.log(`https://console.cloud.google.com/monitoring/dashboards/builder/${String(result.name).split('/').pop()}?project=${project}`);
        }
    },
};

runMain(async ({ positional, flags }) => {
    const [command] = positional;
    if (!commands[command]) {
        throw new Error(`Comando desconocido "${command ?? ''}". Usa: ${Object.keys(commands).join(', ')}`);
    }
    const apply = flags.apply === true;
    const project = optional(flags, 'project', 'PROJECT');
    const client = createGcpClient({ apply, quotaProject: project });
    console.log(apply ? `Aplicando "${command}" en ${project}…` : `En seco: "${command}" (usa --apply para aplicar)`);
    await commands[command](client, flags);
    printSummary();
});
