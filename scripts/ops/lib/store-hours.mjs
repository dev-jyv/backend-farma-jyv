// Horario de tienda para medir (SPEC 34 y SPEC 42).
//
// Sale de `WORKING_HOURS` (functions/src/constants/clinic.ts) tomado de forma
// continua: lunes a viernes 09:00–20:00 (sin el hueco 14:00–16:00 del
// consultorio) y sábado 09:00–13:00; domingo cerrado. Si cambia el horario de la
// farmacia, cambia aquí y en el PromQL del dashboard (defs/monitoring).

export const STORE_TIME_ZONE = 'America/Mexico_City';

/** Índice = día de la semana local (0 = domingo); `[inicio, fin)` en minutos. */
export const STORE_HOURS = Object.freeze([
    null,
    [9 * 60, 20 * 60],
    [9 * 60, 20 * 60],
    [9 * 60, 20 * 60],
    [9 * 60, 20 * 60],
    [9 * 60, 20 * 60],
    [9 * 60, 13 * 60],
]);

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

/** Fecha local (`AAAA-MM-DD`), día de la semana y minuto del día en CDMX. */
export const localParts = (date) => {
    const parts = Object.fromEntries(
        formatter.formatToParts(new Date(date)).map((part) => [part.type, part.value]),
    );
    return {
        ymd: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: WEEKDAYS[parts.weekday],
        minute: Number(parts.hour) * 60 + Number(parts.minute),
    };
};

const weekdayOfYmd = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Día que cuenta para la medición: no domingo ni festivo. */
export const isStoreDay = (ymd, holidays = new Set()) =>
    Boolean(STORE_HOURS[weekdayOfYmd(ymd)]) && !holidays.has(ymd);

export const isStoreTime = (date, holidays = new Set()) => {
    const { ymd, weekday, minute } = localParts(date);
    const hours = STORE_HOURS[weekday];
    return Boolean(hours) && !holidays.has(ymd) && minute >= hours[0] && minute < hours[1];
};

/** `count` días naturales a partir de `fromYmd`, en orden. */
export const calendarDays = (fromYmd, count) => {
    const start = new Date(`${fromYmd}T12:00:00Z`);
    return Array.from({ length: count }, (_value, index) => {
        const day = new Date(start.getTime() + index * 86_400_000);
        return day.toISOString().slice(0, 10);
    });
};

export const WEEKDAY_LABELS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const weekdayLabel = (ymd) => WEEKDAY_LABELS[weekdayOfYmd(ymd)];

/**
 * El mismo horario en UTC (CDMX = UTC−6 fijo) como cláusulas para PromQL, que
 * solo sabe de `day_of_week()` y `hour()` en UTC. La prueba de scripts/ops
 * recorre una semana minuto a minuto y exige que coincida con `isStoreTime`.
 */
export const STORE_HOURS_UTC_CLAUSES = Object.freeze([
    { fromDay: 1, toDay: 5, fromHour: 15, toHour: 24 }, // L–V 09:00–17:59 local
    { fromDay: 2, toDay: 6, fromHour: 0, toHour: 2 }, // L–V 18:00–19:59 local
    { fromDay: 6, toDay: 6, fromHour: 15, toHour: 19 }, // S 09:00–12:59 local
]);

export const storeHoursPromqlMask = () =>
    '(' +
    STORE_HOURS_UTC_CLAUSES.map(({ fromDay, toDay, fromHour, toHour }) => {
        const parts = fromDay === toDay
            ? [`day_of_week() == ${fromDay}`]
            : [`day_of_week() >= ${fromDay}`, `day_of_week() <= ${toDay}`];
        if (fromHour > 0) parts.push(`hour() >= ${fromHour}`);
        if (toHour < 24) parts.push(`hour() < ${toHour}`);
        return `(${parts.join(' and ')})`;
    }).join(' or ') +
    ')';

export const isStoreTimeByUtcClauses = (date) => {
    const at = new Date(date);
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    return STORE_HOURS_UTC_CLAUSES.some((clause) => day >= clause.fromDay && day <= clause.toDay &&
        hour >= clause.fromHour && hour < clause.toHour);
};
