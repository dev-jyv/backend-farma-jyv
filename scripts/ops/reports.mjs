#!/usr/bin/env node
// Reportes de solo lectura para decidir con datos (SPEC 34 y SPEC 42).
//
//   node scripts/ops/reports.mjs cold-start --project farma-jyv --from 2026-11-03 [--days 14]
//        [--holidays 2026-11-16] [--input entradas.json]
//   node scripts/ops/reports.mjs instances  --project farma-jyv [--from 2026-11-03] [--days 14]
//
// No cambian nada en GCP: leen Logging (`gcloud logging read`) o Monitoring
// (`timeSeries.list`). `--input` permite rehacer la tabla con un volcado guardado.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createGcpClient, list, need, optional, runMain } from './lib/cli.mjs';
import { analyzeColdStarts, coldStartFilter, formatColdStartTable } from './lib/cold-start.mjs';
import {
    INSTANCE_FILTER,
    INSTANCE_STREAK_DAYS,
    INSTANCE_THRESHOLD,
    dailyStoreMax,
    evaluateInstanceTrigger,
} from './lib/instances.mjs';
import { calendarDays, isStoreDay, weekdayLabel } from './lib/store-hours.mjs';

/** Medianoche de CDMX (UTC−6 fijo) del día `ymd`, en ISO UTC. */
const localMidnightUtc = (ymd) => new Date(`${ymd}T06:00:00Z`).toISOString();

/** Días naturales a medir; por defecto los `days` que terminan ayer (CDMX). */
const measurementWindow = (flags, defaultDays) => {
    const days = Number(optional(flags, 'days', undefined, String(defaultDays)));
    const todayLocal = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
    const defaultFrom = new Date(Date.parse(`${todayLocal}T12:00:00Z`) - days * 86_400_000)
        .toISOString().slice(0, 10);
    const from = optional(flags, 'from', undefined, defaultFrom);
    const range = calendarDays(from, days);
    const after = calendarDays(range[range.length - 1], 2)[1];
    return { days, from, range, startTime: localMidnightUtc(from), endTime: localMidnightUtc(after) };
};

const commands = {
    'cold-start'(flags) {
        const project = need(flags, 'project', 'PROJECT');
        const { days, from, startTime, endTime } = measurementWindow(flags, 14);
        const holidays = list(optional(flags, 'holidays', 'STORE_HOLIDAYS', ''));
        const input = optional(flags, 'input');
        const entries = input
            ? JSON.parse(readFileSync(input, 'utf8'))
            : JSON.parse(execFileSync('gcloud', [
                'logging', 'read', coldStartFilter(project, { from: startTime, to: endTime }),
                `--project=${project}`, '--format=json', '--order=asc',
            ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
        const result = analyzeColdStarts(entries, {
            from,
            days,
            holidays,
            deployGraceMinutes: Number(optional(flags, 'deploy-grace-minutes', undefined, '10')),
        });
        console.log(`Arranques en frío de api, ${from} + ${days} días (horario de tienda, CDMX)\n`);
        console.log(formatColdStartTable(result));
    },

    async instances(flags) {
        const project = need(flags, 'project', 'PROJECT');
        const { range, startTime, endTime } = measurementWindow(flags, 14);
        const holidays = list(optional(flags, 'holidays', 'STORE_HOLIDAYS', ''));
        const client = createGcpClient({ apply: false, allowReads: true, quotaProject: project });
        const points = [];
        let pageToken = '';
        do {
            const params = new URLSearchParams({
                filter: INSTANCE_FILTER,
                'interval.startTime': startTime,
                'interval.endTime': endTime,
                'aggregation.alignmentPeriod': '300s',
                'aggregation.perSeriesAligner': 'ALIGN_MAX',
                'aggregation.crossSeriesReducer': 'REDUCE_SUM',
                ...(pageToken ? { pageToken } : {}),
            });
            const page = await client.get(
                `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${params}`,
            );
            for (const series of page?.timeSeries ?? []) points.push(...series.points);
            pageToken = page?.nextPageToken ?? '';
        } while (pageToken);

        const daily = dailyStoreMax(points, holidays);
        const storeDays = range.filter((ymd) => isStoreDay(ymd, new Set(holidays)));
        const trigger = evaluateInstanceTrigger(daily, storeDays);
        const maxByDay = new Map(daily.map((day) => [day.ymd, day.max]));
        console.log('| Día | | Máx. instancias activas en horario |');
        console.log('|---|---|---:|');
        for (const ymd of range) {
            console.log(isStoreDay(ymd, new Set(holidays))
                ? `| ${ymd} | ${weekdayLabel(ymd)} | ${maxByDay.get(ymd) ?? 0} |`
                : `| ${ymd} | ${weekdayLabel(ymd)} | cerrado/festivo |`);
        }
        console.log(`\nRacha más larga > ${INSTANCE_THRESHOLD}: ${trigger.longestStreak} día(s) de tienda.`);
        console.log(trigger.triggered
            ? `DISPARADOR CUMPLIDO (≥ ${INSTANCE_STREAK_DAYS} días seguidos): abrir el spec nuevo (RUNBOOK §9).`
            : `Disparador por instancias no cumplido. Revisar también el gasto de OpenRouter (RUNBOOK §9).`);
    },
};

runMain(async ({ positional, flags }) => {
    const [command] = positional;
    if (!commands[command]) {
        throw new Error(`Comando desconocido "${command ?? ''}". Usa: ${Object.keys(commands).join(', ')}`);
    }
    await commands[command](flags);
});
