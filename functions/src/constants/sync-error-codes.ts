/**
 * Códigos de error de sincronización entre la caja y el backend (SPEC 49).
 *
 * El POS decide si reintenta, bloquea o concilia una venta o una entrada leyendo
 * **este código**, no el texto del mensaje: el texto cambia con cada redacción y
 * el clasificador por `includes('stock')` mandaba ventas cobradas al diagnóstico
 * "desconocido". El catálogo se copia tal cual en el POS (`shared/models`): un
 * contrato distinto en cada repo es un bug, así que agregar o renombrar uno es un
 * cambio de los dos lados.
 *
 * Es independiente del `code` HTTP de `AppError` (`BAD_REQUEST`, `CONFLICT`...):
 * "stock insuficiente" y "turno cerrado" son los dos un 400, pero el POS los
 * resuelve por caminos distintos.
 */
export const SYNC_ERROR_CODES = [
    // Inventario y catálogo: camino de conciliación (SPEC 52).
    'STOCK_INSUFFICIENT',
    'BATCH_EXPIRED',
    'PRODUCT_NOT_FOUND',
    'PRODUCT_INACTIVE',
    // Turno de caja: bloqueo visible.
    'SESSION_CLOSED',
    'SESSION_FORBIDDEN',
    // Lote de sincronización.
    'IDEMPOTENCY_CONFLICT',
    'VALIDATION',
    'DEFERRED',
    // Entradas de mercancía.
    'ENTRY_IN_PROGRESS',
    'ENTRY_AMBIGUOUS',
    // La factura ya tiene una entrada igual con otra llave (SPEC 58): bloqueo visible.
    'ENTRY_POSSIBLE_DUPLICATE',
    // Anulaciones.
    'ALREADY_VOIDED',
    'HAS_RETURNS',
    'VOID_FORBIDDEN',
    // Cualquier error no previsto (Firestore `ABORTED`, caída de un servicio...).
    'INTERNAL',
] as const;

export type SyncErrorCode = typeof SYNC_ERROR_CODES[number];

/**
 * Códigos que por sí mismos significan "vuelve a intentarlo": la operación no se
 * rechazó, no se pudo decidir todavía. El POS los deja pendientes sin marcar
 * `pushError` ni contar el intento como fallido.
 */
const RETRYABLE_SYNC_ERROR_CODES: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>([
    'DEFERRED',
    'ENTRY_IN_PROGRESS',
    'INTERNAL',
]);

export const isRetryableSyncErrorCode = (code: SyncErrorCode): boolean =>
    RETRYABLE_SYNC_ERROR_CODES.has(code);
