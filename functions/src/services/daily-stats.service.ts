import { db } from '../utils/firestore';
import { toCents } from '../utils/taxes';
import { fromDate } from '../utils/firestore';
import { addDaysYmd, zonedStartOfDayMs } from '../utils/timezone';
import * as dailyStatsRepo from '../repositories/daily-stats.repository';
import { DailyStats } from '../repositories/daily-stats.repository';

/**
 * Recalcula `dailyStats` desde las ventas. Es la fuente de verdad contra la que
 * se verifica el agregado que mantienen las transacciones, y lo que el backfill
 * escribe para los días anteriores a que existiera.
 */
export const computeDailyStatsFromSales = async (): Promise<Map<string, DailyStats>> => {
    const snapshot = await db()
        .collection('sales')
        .select('createdAt', 'total', 'voidedAt')
        .get();

    const days = new Map<string, DailyStats>();
    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.voidedAt) {
            continue;
        }
        const ymd = dailyStatsRepo.statsDayOf(data.createdAt.toDate());
        const day = days.get(ymd) ?? { ymd, salesTotalCents: 0, salesCount: 0 };
        day.salesTotalCents += toCents(Number(data.total ?? 0));
        day.salesCount += 1;
        days.set(ymd, day);
    }
    return days;
};

export interface DailyStatsDiff {
    ymd: string;
    stored: DailyStats | null;
    expected: DailyStats | null;
}

/** Días donde lo guardado difiere de lo que dicen las ventas. Vacío = el agregado es fiel. */
export const diffDailyStats = async (): Promise<DailyStatsDiff[]> => {
    const expected = await computeDailyStatsFromSales();
    const stored = new Map(
        (await dailyStatsRepo.listDailyStats('0000-01-01', '9999-12-31')).map((day) => [
            day.ymd,
            day,
        ]),
    );

    const diffs: DailyStatsDiff[] = [];
    for (const ymd of new Set([...expected.keys(), ...stored.keys()])) {
        const want = expected.get(ymd) ?? null;
        const have = stored.get(ymd) ?? null;
        const wantTotal = want?.salesTotalCents ?? 0;
        const wantCount = want?.salesCount ?? 0;
        if (
            (have?.salesTotalCents ?? 0) !== wantTotal ||
            (have?.salesCount ?? 0) !== wantCount
        ) {
            diffs.push({ ymd, stored: have, expected: want });
        }
    }
    return diffs.sort((a, b) => a.ymd.localeCompare(b.ymd));
};

/** Reescribe solo los días que difieren. Devuelve cuántos tocó. */
export const rebuildDailyStats = async (): Promise<number> => {
    const diffs = await diffDailyStats();
    for (const diff of diffs) {
        await dailyStatsRepo.setDay(
            diff.expected ?? { ymd: diff.ymd, salesTotalCents: 0, salesCount: 0 },
        );
    }
    return diffs.length;
};

const sumSalesByDay = async (
    fromYmd: string,
    toYmd: string,
): Promise<Map<string, DailyStats>> => {
    const snapshot = await db()
        .collection('sales')
        .where(
            'createdAt',
            '>=',
            fromDate(new Date(zonedStartOfDayMs(fromYmd, dailyStatsRepo.DAILY_STATS_TIME_ZONE))),
        )
        .where(
            'createdAt',
            '<',
            fromDate(new Date(zonedStartOfDayMs(toYmd, dailyStatsRepo.DAILY_STATS_TIME_ZONE))),
        )
        .select('createdAt', 'total', 'voidedAt')
        .get();
    const days = new Map<string, DailyStats>();
    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (data.voidedAt) {
            continue;
        }
        const ymd = dailyStatsRepo.statsDayOf(data.createdAt.toDate());
        const day = days.get(ymd) ?? { ymd, salesTotalCents: 0, salesCount: 0 };
        day.salesTotalCents += toCents(Number(data.total ?? 0));
        day.salesCount += 1;
        days.set(ymd, day);
    }
    return days;
};

/**
 * Compara `dailyStats` contra las ventas de los últimos `days` días locales
 * (incluido hoy). Cuesta una lectura por venta de esa ventana, no del histórico.
 */
export const diffRecentDailyStats = async (
    days = 7,
    today: Date = new Date(),
): Promise<DailyStatsDiff[]> => {
    const lastYmd = dailyStatsRepo.statsDayOf(today);
    const fromYmd = addDaysYmd(lastYmd, -(days - 1));
    const toYmd = addDaysYmd(lastYmd, 1);
    const expected = await sumSalesByDay(fromYmd, toYmd);
    const stored = new Map(
        (await dailyStatsRepo.listDailyStats(fromYmd, toYmd)).map((day) => [day.ymd, day]),
    );

    const diffs: DailyStatsDiff[] = [];
    for (const ymd of new Set([...expected.keys(), ...stored.keys()])) {
        const want = expected.get(ymd) ?? null;
        const have = stored.get(ymd) ?? null;
        if (
            (have?.salesTotalCents ?? 0) !== (want?.salesTotalCents ?? 0) ||
            (have?.salesCount ?? 0) !== (want?.salesCount ?? 0)
        ) {
            diffs.push({ ymd, stored: have, expected: want });
        }
    }
    return diffs.sort((a, b) => a.ymd.localeCompare(b.ymd));
};

/**
 * Job diario: registra una alerta (`console.error`, severidad ERROR en Cloud
 * Logging, apta para una alerta basada en logs) por cada día con diferencia.
 */
export const checkDailyStatsIntegrity = async (
    days = 7,
    today: Date = new Date(),
): Promise<DailyStatsDiff[]> => {
    const diffs = await diffRecentDailyStats(days, today);
    for (const diff of diffs) {
        console.error(
            `ALERTA dailyStats: diferencia en ${diff.ymd}. ` +
                `Guardado: ${JSON.stringify(diff.stored)}; ` +
                `según ventas: ${JSON.stringify(diff.expected)}. ` +
                'Corregir con `npm run backfill:daily-stats`.',
        );
    }
    if (diffs.length === 0) {
        console.log(`dailyStats íntegro en los últimos ${days} días`);
    }
    return diffs;
};
