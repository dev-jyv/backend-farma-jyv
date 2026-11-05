import { timingSafeEqual } from 'crypto';
import { getMigrateSecret } from '../config/env';
import { forbidden } from './errors';

const secretMatches = (provided: string, expected: string): boolean => {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
};

/**
 * Las rutas internas (`/v1/internal/*` y `accountantReportTrigger`) no llevan
 * token de usuario: las abre el header `x-migrate-secret`, comparado en tiempo
 * constante contra `MIGRATE_SECRET`. Sin secreto configurado no abre nada.
 */
export const assertMigrateSecret = (providedSecret?: string): void => {
    const secret = getMigrateSecret();
    if (!secret || !providedSecret || !secretMatches(providedSecret, secret)) {
        throw forbidden();
    }
};
