import { db } from '../utils/firestore';
import { toCents } from '../utils/taxes';
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
