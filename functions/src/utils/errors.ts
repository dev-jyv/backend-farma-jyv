import { isRetryableSyncErrorCode, SyncErrorCode } from '../constants/sync-error-codes';

export interface AppErrorOptions {
    /**
     * Código de negocio estable que lee el POS (SPEC 49). Es distinto del `code`
     * HTTP: dos 400 pueden pedir caminos opuestos en la caja.
     */
    syncCode?: SyncErrorCode;
    /** Por default lo decide el código (o el status ≥ 500 si no hay código). */
    retryable?: boolean;
    /**
     * Datos de apoyo que viajan en `error.details` junto a `code` y `retryable`
     * (nunca los pisan), p. ej. la entrada existente de un posible duplicado
     * (SPEC 58) o `current` en `CATALOG_CONFLICT` (SPEC 56).
     */
    details?: Record<string, unknown>;
}

export class AppError extends Error {
    public readonly syncCode?: SyncErrorCode;
    public readonly retryable: boolean;
    public readonly details?: Record<string, unknown>;

    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string,
        options: AppErrorOptions = {},
    ) {
        super(message);
        this.name = 'AppError';
        this.syncCode = options.syncCode;
        this.details = options.details;
        this.retryable = options.retryable ??
            (options.syncCode ? isRetryableSyncErrorCode(options.syncCode) : statusCode >= 500);
    }
}

/**
 * `true` solo para un rechazo de negocio (`AppError` < 500): el único error que
 * garantiza que una operación idempotente no escribió nada y que su llave se
 * puede liberar. Un 5xx o un error cualquiera (timeout, commit ambiguo) pudo
 * haberla aplicado, así que la llave se conserva (SPEC 55).
 */
export const isReleasableError = (error: unknown): boolean =>
    error instanceof AppError && error.statusCode < 500;

const syncOptions = (syncCode?: SyncErrorCode): AppErrorOptions =>
    (syncCode ? { syncCode } : {});

export const notFound = (resource: string, syncCode?: SyncErrorCode): AppError =>
    new AppError(404, 'NOT_FOUND', `${resource} no encontrado`, syncOptions(syncCode));

export const forbidden = (
    message = 'No tienes permisos para esta acción',
    syncCode?: SyncErrorCode,
): AppError =>
    new AppError(403, 'FORBIDDEN', message, syncOptions(syncCode));

export const unauthorized = (message = 'Token inválido o ausente'): AppError =>
    new AppError(401, 'UNAUTHORIZED', message);

export const badRequest = (message: string, syncCode?: SyncErrorCode): AppError =>
    new AppError(400, 'BAD_REQUEST', message, syncOptions(syncCode));

export const conflict = (message: string, syncCode?: SyncErrorCode): AppError =>
    new AppError(409, 'CONFLICT', message, syncOptions(syncCode));

export const unprocessable = (message: string): AppError =>
    new AppError(422, 'UNPROCESSABLE', message);

/**
 * Le pone `syncCode` a un rechazo de negocio (4xx) que no lo traía, conservando
 * status, código HTTP, mensaje y stack. Lo demás pasa intacto: un error que no es
 * `AppError`, o uno ≥ 500, sale como `INTERNAL` por `describeSyncError`.
 *
 * Es lo que deja a `createSale`, `voidSale` y `createStockEntry` sin un 4xx mudo:
 * lo que no tiene un código propio es una validación que la caja muestra.
 */
export const withDefaultSyncCode = (error: unknown, syncCode: SyncErrorCode): unknown => {
    if (!(error instanceof AppError) || error.statusCode >= 500 || error.syncCode) {
        return error;
    }
    const tagged = new AppError(error.statusCode, error.code, error.message, {
        syncCode,
        ...(error.details ? { details: error.details } : {}),
    });
    tagged.stack = error.stack;
    return tagged;
};

export interface SyncErrorDescription {
    code: SyncErrorCode;
    retryable: boolean;
    message: string;
}

/**
 * Traduce cualquier error al contrato de sincronización (SPEC 49):
 *
 *  - `AppError` 4xx → su `syncCode` (o `VALIDATION` si no tiene) y su `retryable`;
 *  - `AppError` ≥ 500 o cualquier otro error (un `ABORTED` de Firestore tras sus
 *    reintentos, una caída de red hacia Mercado Pago) → `INTERNAL`, reintentable:
 *    no se rechazó la operación, no se pudo decidir.
 */
export const describeSyncError = (error: unknown): SyncErrorDescription => {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    if (error instanceof AppError && error.statusCode < 500) {
        return {
            code: error.syncCode ?? 'VALIDATION',
            retryable: error.retryable,
            message,
        };
    }
    return { code: 'INTERNAL', retryable: true, message };
};
