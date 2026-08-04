import { unauthorized } from './errors';
import { addDaysYmd, getZonedYmd, zonedStartOfDayMs } from './timezone';

export const SESSION_TIME_ZONE = 'America/Mexico_City';

export const getSessionExpiryMs = (authTimeUnix: number): number => {
    const authYmd = getZonedYmd(authTimeUnix * 1000, SESSION_TIME_ZONE);
    return zonedStartOfDayMs(addDaysYmd(authYmd, 1), SESSION_TIME_ZONE);
};

export const assertSessionNotExpired = (authTimeUnix: number, nowMs = Date.now()): void => {
    if (nowMs >= getSessionExpiryMs(authTimeUnix)) {
        throw unauthorized('La sesión expiró a las 24:00. Inicia sesión nuevamente');
    }
};
