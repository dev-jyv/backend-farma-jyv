// Disparador de límites compartidos (SPEC 42): máximo diario de instancias
// activas de `api` en horario de tienda y racha de días por encima de 3.
import { isStoreDay, isStoreTime, localParts } from './store-hours.mjs';

export const INSTANCE_THRESHOLD = 3;
export const INSTANCE_STREAK_DAYS = 7;

export const INSTANCE_FILTER =
    'metric.type="run.googleapis.com/container/instance_count" AND ' +
    'resource.type="cloud_run_revision" AND resource.label.service_name="api" AND ' +
    'metric.label.state="active"';

const pointValue = (point) =>
    Number(point.value?.int64Value ?? point.value?.doubleValue ?? Number.NaN);

/**
 * @param points puntos de `timeSeries.list` (ya sumados entre revisiones), cada
 *        uno con `interval.endTime` y `value`
 * @returns [{ ymd, max }] por día de tienda con datos, ordenado
 */
export const dailyStoreMax = (points, holidays = []) => {
    const holidaySet = new Set(holidays);
    const byDay = new Map();
    for (const point of points) {
        const at = Date.parse(point.interval?.endTime ?? point.interval?.startTime);
        const value = pointValue(point);
        if (Number.isNaN(at) || Number.isNaN(value) || !isStoreTime(at, holidaySet)) continue;
        const { ymd } = localParts(at);
        byDay.set(ymd, Math.max(byDay.get(ymd) ?? 0, value));
    }
    return [...byDay.entries()]
        .filter(([ymd]) => isStoreDay(ymd, holidaySet))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ymd, max]) => ({ ymd, max }));
};

/**
 * "7 días seguidos" cuenta días **de tienda** consecutivos: el domingo (cerrado)
 * ni suma ni corta la racha; un día de tienda sin datos o en ≤ 3 sí la corta.
 */
export const evaluateInstanceTrigger = (storeDays, allStoreDaysInRange,
    { threshold = INSTANCE_THRESHOLD, streakDays = INSTANCE_STREAK_DAYS } = {}) => {
    const maxByDay = new Map(storeDays.map((day) => [day.ymd, day.max]));
    let streak = 0;
    let longest = 0;
    for (const ymd of allStoreDaysInRange) {
        streak = (maxByDay.get(ymd) ?? 0) > threshold ? streak + 1 : 0;
        longest = Math.max(longest, streak);
    }
    return { longestStreak: longest, currentStreak: streak, triggered: longest >= streakDays };
};
