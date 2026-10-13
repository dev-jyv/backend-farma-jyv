import { addDaysYmd, getZonedYmd, zonedStartOfDayMs } from '../utils/timezone';
import { fromCents, toCents } from '../utils/taxes';
import { REPORTS_TIME_ZONE } from './sales-reports.service';

/**
 * Serie de ventas por día o por semana para los análisis de producto y de
 * servicio. La serie mensual de cada análisis ya existe (`monthly`); esta es la
 * misma idea con otro tamaño de cubeta, sobre las mismas ventas que ya se leen,
 * así que no cuesta lecturas extra.
 */

export type Granularity = 'day' | 'week' | 'month';

export const DEFAULT_PERIODS: Record<Exclude<Granularity, 'month'>, number> = {
    day: 30,
    week: 12,
};

export const MAX_PERIODS: Record<Exclude<Granularity, 'month'>, number> = {
    day: 90,
    week: 52,
};

export interface SeriesOptions {
    granularity: Exclude<Granularity, 'month'>;
    periods: number;
}

/** Una fila de venta (o de devolución, con signo negativo) ya aplanada. */
export interface SeriesRow {
    ms: number;
    units: number;
    netCents: number;
    commissionCents: number;
    /** Precio unitario cobrado; las devoluciones no lo informan. */
    unitPrice?: number;
}

export interface SeriesPoint {
    /** Primer día de la cubeta (`YYYY-MM-DD`; el lunes en las semanas). */
    bucket: string;
    units: number;
    revenue: number;
    commission: number;
    net: number;
    avgPrice: number | null;
    minPrice: number | null;
    maxPrice: number | null;
}

export const clampPeriods = (granularity: SeriesOptions['granularity'], periods?: number): number =>
    Math.min(
        Math.max(Math.trunc(periods ?? 0) || DEFAULT_PERIODS[granularity], 1),
        MAX_PERIODS[granularity],
    );

/** Lunes de la semana local que contiene a `ymd`. */
const mondayOf = (ymd: string): string => {
    const [year, month, day] = ymd.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return addDaysYmd(ymd, -((weekday + 6) % 7));
};

export const bucketOf = (ms: number, granularity: SeriesOptions['granularity']): string => {
    const ymd = getZonedYmd(ms, REPORTS_TIME_ZONE);
    return granularity === 'day' ? ymd : mondayOf(ymd);
};

/** Cubetas de la ventana, de la más antigua a la actual. */
export const bucketKeys = (nowMs: number, options: SeriesOptions): string[] => {
    const last = bucketOf(nowMs, options.granularity);
    const step = options.granularity === 'day' ? 1 : 7;
    const keys: string[] = [];
    for (let i = options.periods - 1; i >= 0; i -= 1) {
        keys.push(addDaysYmd(last, -i * step));
    }
    return keys;
};

/** Inicio (ms) de la primera cubeta: desde ahí hay que leer ventas. */
export const seriesStartMs = (nowMs: number, options: SeriesOptions): number =>
    zonedStartOfDayMs(bucketKeys(nowMs, options)[0], REPORTS_TIME_ZONE);

export const buildSeries = (
    rows: readonly SeriesRow[],
    nowMs: number,
    options: SeriesOptions,
): SeriesPoint[] => {
    const keys = bucketKeys(nowMs, options);
    const accs = new Map(keys.map((key) => [key, {
        units: 0,
        netCents: 0,
        commissionCents: 0,
        soldUnits: 0,
        priceWeightCents: 0,
        min: null as number | null,
        max: null as number | null,
    }]));

    for (const row of rows) {
        const acc = accs.get(bucketOf(row.ms, options.granularity));
        if (!acc) {
            continue;
        }
        acc.units += row.units;
        acc.netCents += row.netCents;
        acc.commissionCents += row.commissionCents;
        if (row.unitPrice !== undefined) {
            acc.soldUnits += row.units;
            acc.priceWeightCents += toCents(row.unitPrice) * row.units;
            acc.min = acc.min === null ? row.unitPrice : Math.min(acc.min, row.unitPrice);
            acc.max = acc.max === null ? row.unitPrice : Math.max(acc.max, row.unitPrice);
        }
    }

    return keys.map((bucket) => {
        const acc = accs.get(bucket)!;
        return {
            bucket,
            units: acc.units,
            revenue: fromCents(acc.netCents),
            commission: fromCents(acc.commissionCents),
            net: fromCents(acc.netCents - acc.commissionCents),
            avgPrice: acc.soldUnits > 0
                ? fromCents(Math.round(acc.priceWeightCents / acc.soldUnits))
                : null,
            minPrice: acc.min,
            maxPrice: acc.max,
        };
    });
};
