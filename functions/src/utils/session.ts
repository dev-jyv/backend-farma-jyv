import { unauthorized } from './errors';

export const SESSION_TIME_ZONE = 'America/Mexico_City';

const getZonedYmd = (ms: number, timeZone: string): string =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms));

const addOneDayYmd = (ymd: string): string => {
    const [year, month, day] = ymd.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
};

const zonedStartOfDayMs = (ymd: string, timeZone: string): number => {
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

export const getSessionExpiryMs = (authTimeUnix: number): number => {
    const authYmd = getZonedYmd(authTimeUnix * 1000, SESSION_TIME_ZONE);
    return zonedStartOfDayMs(addOneDayYmd(authYmd), SESSION_TIME_ZONE);
};

export const assertSessionNotExpired = (authTimeUnix: number, nowMs = Date.now()): void => {
    if (nowMs >= getSessionExpiryMs(authTimeUnix)) {
        throw unauthorized('La sesión expiró a las 24:00. Inicia sesión nuevamente');
    }
};
