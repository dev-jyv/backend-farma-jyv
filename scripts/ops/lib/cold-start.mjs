// Medición del arranque en frío de `api` (SPEC 34).
//
// Entrada: las entradas de Logging que devuelve la consulta guardada (ver
// `coldStartFilter`), en el JSON de `gcloud logging read --format=json`.
// Un arranque es la línea de sistema "Starting new instance. Reason: …" y su
// latencia en frío es la de la **primera petición** con el mismo
// `labels.instanceId` (esa petición esperó a que la instancia arrancara).
import { calendarDays, isStoreDay, isStoreTime, localParts, weekdayLabel } from './store-hours.mjs';

export const COLD_START_P95_THRESHOLD_SECONDS = 3;

/** Filtro de Logging: arranques de instancia y peticiones de `api`. */
export const coldStartFilter = (project, { from, to } = {}) =>
    [
        'resource.type="cloud_run_revision"',
        'resource.labels.service_name="api"',
        '(' +
            `(logName="projects/${project}/logs/run.googleapis.com%2Fvarlog%2Fsystem"` +
            ' AND textPayload:"Starting new instance")' +
            ` OR logName="projects/${project}/logs/run.googleapis.com%2Frequests"` +
            ')',
        ...(from ? [`timestamp>="${from}"`] : []),
        ...(to ? [`timestamp<"${to}"`] : []),
    ].join('\n');

export const parseLatencySeconds = (latency) => {
    if (latency === undefined || latency === null) return Number.NaN;
    return Number(String(latency).trim().replace(/s$/, ''));
};

/** Percentil por rango más cercano (el que se puede rehacer a mano con la lista). */
export const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};

const instanceIdOf = (entry) => entry.labels?.instanceId;
const isStartEntry = (entry) => String(entry.textPayload ?? '').startsWith('Starting new instance');

/**
 * @param entries entradas de Logging (cualquier orden)
 * @param options.from primer día (AAAA-MM-DD, CDMX) de la ventana de 14 días
 * @param options.days número de días naturales (14)
 * @param options.holidays días festivos (AAAA-MM-DD) que no cuentan
 * @param options.deployGraceMinutes arranques a menos de N min de la primera
 *        aparición de una revisión se tratan como despliegue
 */
export const analyzeColdStarts = (entries, options) => {
    const { from, days = 14, holidays = [], deployGraceMinutes = 10 } = options;
    const holidaySet = new Set(holidays);
    const sorted = [...entries].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

    const revisionFirstSeen = new Map();
    const firstRequestByInstance = new Map();
    const starts = [];
    for (const entry of sorted) {
        const revision = entry.resource?.labels?.revision_name;
        if (revision && !revisionFirstSeen.has(revision)) {
            revisionFirstSeen.set(revision, Date.parse(entry.timestamp));
        }
        if (isStartEntry(entry)) {
            starts.push(entry);
        } else if (entry.httpRequest && instanceIdOf(entry) && !firstRequestByInstance.has(instanceIdOf(entry))) {
            firstRequestByInstance.set(instanceIdOf(entry), entry);
        }
    }

    const range = new Set(calendarDays(from, days));
    const byDay = new Map([...range].map((ymd) => [ymd, []]));
    const excluded = { deployment: 0, offHours: 0, closedDay: 0, noRequest: 0, outOfRange: 0 };

    for (const start of starts) {
        const at = Date.parse(start.timestamp);
        const { ymd } = localParts(at);
        const reason = /Reason: ([A-Z_]+)/.exec(String(start.textPayload))?.[1] ?? 'DESCONOCIDO';
        const revisionStart = revisionFirstSeen.get(start.resource?.labels?.revision_name);
        if (!range.has(ymd)) excluded.outOfRange += 1;
        else if (reason === 'DEPLOYMENT' ||
            (revisionStart !== undefined && at - revisionStart < deployGraceMinutes * 60_000)) {
            excluded.deployment += 1;
        } else if (!isStoreDay(ymd, holidaySet)) excluded.closedDay += 1;
        else if (!isStoreTime(at, holidaySet)) excluded.offHours += 1;
        else {
            const request = firstRequestByInstance.get(instanceIdOf(start));
            const latency = parseLatencySeconds(request?.httpRequest?.latency);
            if (!request || Number.isNaN(latency)) excluded.noRequest += 1;
            else byDay.get(ymd).push(latency);
        }
    }

    const rows = [...range].map((ymd) => {
        const latencies = byDay.get(ymd);
        return {
            ymd,
            weekday: weekdayLabel(ymd),
            counts: isStoreDay(ymd, holidaySet),
            starts: latencies.length,
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
        };
    });
    const all = [...byDay.values()].flat();
    const p95 = percentile(all, 0.95);
    return {
        rows,
        excluded,
        overall: { starts: all.length, p50: percentile(all, 0.5), p95 },
        recommendMinInstances: p95 !== null && p95 > COLD_START_P95_THRESHOLD_SECONDS,
    };
};

const seconds = (value) => (value === null ? '—' : `${value.toFixed(2)} s`);

/** Tabla Markdown lista para pegar en el RUNBOOK §8 / SPEC 34. */
export const formatColdStartTable = (result) => {
    const lines = [
        '| Día | | Arranques en horario | p50 1.ª petición | p95 1.ª petición |',
        '|---|---|---:|---:|---:|',
        ...result.rows.map((row) =>
            row.counts
                ? `| ${row.ymd} | ${row.weekday} | ${row.starts} | ${seconds(row.p50)} | ${seconds(row.p95)} |`
                : `| ${row.ymd} | ${row.weekday} | cerrado/festivo: no cuenta | — | — |`,
        ),
        `| **14 días** | | **${result.overall.starts}** | **${seconds(result.overall.p50)}** | **${seconds(result.overall.p95)}** |`,
        '',
        `Excluidos: ${result.excluded.deployment} por despliegue, ${result.excluded.offHours} fuera de horario, ` +
            `${result.excluded.closedDay} en domingo/festivo, ${result.excluded.noRequest} sin petición.`,
        result.overall.p95 === null
            ? 'Sin arranques en horario: no hay p95 que comparar.'
            : result.recommendMinInstances
                ? `p95 ${seconds(result.overall.p95)} > ${COLD_START_P95_THRESHOLD_SECONDS} s: proponer minInstances: 1 en horario (SPEC 34 req. 3).`
                : `p95 ${seconds(result.overall.p95)} ≤ ${COLD_START_P95_THRESHOLD_SECONDS} s: no cambiar la configuración (SPEC 34 req. 4).`,
    ];
    return lines.join('\n');
};
