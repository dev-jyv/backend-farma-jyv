/**
 * Helpers de zona horaria. La Function corre en UTC, pero farmacia y consultorio
 * viven en `America/Mexico_City`: un "día" (corte de caja, agenda del día) es el
 * día local, no el de UTC. `zonedStartOfDayMs` busca el instante por bisección
 * sobre `Intl` en vez de sumar un offset fijo, así que sigue siendo correcto si
 * la zona vuelve a tener horario de verano.
 */

export const getZonedYmd = (ms: number, timeZone: string): string =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms));

export const addDaysYmd = (ymd: string, days: number): string => {
    const [year, month, day] = ymd.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

export const zonedStartOfDayMs = (ymd: string, timeZone: string): number => {
    let lo = Date.parse(`${ymd}T00:00:00Z`) - 14 * 3600 * 1000;
    let hi = Date.parse(`${ymd}T00:00:00Z`) + 14 * 3600 * 1000;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (getZonedYmd(mid, timeZone) < ymd) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
};

/** `[inicio, fin)` del día local: fin es el inicio del día siguiente. */
export const zonedDayRangeMs = (
    ymd: string,
    timeZone: string,
): { startMs: number; endMs: number } => ({
    startMs: zonedStartOfDayMs(ymd, timeZone),
    endMs: zonedStartOfDayMs(addDaysYmd(ymd, 1), timeZone),
});

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normaliza un extremo de rango recibido por query string.
 *
 * Un cliente que manda una fecha pelada (`2026-08-07`) espera "ese día en la
 * farmacia", pero `new Date('2026-08-07')` es medianoche **UTC**, que en Ciudad
 * de México son las 18:00 del día anterior; y `2026-08-07T23:59:59.999` sin zona
 * se interpreta como hora local del proceso, que en Cloud Functions es UTC. En
 * ambos casos la ventana se corre ~6 h: entran movimientos de la tarde anterior
 * y se pierden los de la tarde del último día.
 *
 * Con offset o `Z` explícitos se respeta el instante tal cual: el cliente ya dijo
 * exactamente qué quería.
 */
export const resolveRangeBoundary = (
    value: string,
    timeZone: string,
    edge: 'start' | 'end',
): Date => {
    if (!BARE_DATE.test(value)) {
        return new Date(value);
    }
    const { startMs, endMs } = zonedDayRangeMs(value, timeZone);
    // `endMs` es el inicio del día siguiente; el rango del libro es inclusivo.
    return new Date(edge === 'start' ? startMs : endMs - 1);
};

/** Minutos transcurridos del día local para un instante dado. */
export const zonedMinutesOfDay = (ms: number, timeZone: string): number => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(ms));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
};

/** Día de la semana local, 0 = domingo. */
export const zonedWeekday = (ms: number, timeZone: string): number => {
    const label = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
        .format(new Date(ms));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
};
