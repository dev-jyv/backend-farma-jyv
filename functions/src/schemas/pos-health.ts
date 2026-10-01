import { z } from 'zod';

/**
 * Salud de cajas. El diagnóstico lo arma la caja con lo que tenga en su SQLite
 * y es justo el reporte que necesitamos **cuando algo está mal**: si un mensaje
 * de error largo o una lista un poco más grande de lo pactado lo rechazara con
 * 400, el servidor se quedaría ciego precisamente en el caso que se quiere ver.
 * Por eso los textos y las listas se **recortan** en vez de rechazarse; solo se
 * rechaza lo que no se puede interpretar (tipos, enums, `deviceId`).
 */

/** Tope de cualquier texto libre: errores de push, etiquetas, mensajes del log. */
export const POS_TEXT_MAX = 500;

export const POS_DIAGNOSTICS_LIMITS = {
    blockedSales: 200,
    /** No está en el contrato; sin tope, 200 ventas × N bloqueos desbordan el documento. */
    blockersPerSale: 20,
    blockedCashSessions: 100,
    unsyncedProducts: 200,
    recentSyncRuns: 50,
    syncLog: 200,
} as const;

const truncate = (max: number) => (value: string): string =>
    value.length > max ? value.slice(0, max) : value;

/** Texto obligatorio, recortado a `max`. */
const text = (max = POS_TEXT_MAX) => z.string().transform(truncate(max));

/** Texto opcional: `null`/ausente se normaliza a `null`, que es lo que espera el contrato. */
const nullableText = (max = POS_TEXT_MAX) =>
    z.string().nullish().transform((value) => (value == null ? null : truncate(max)(value)));

/**
 * Fecha tal como la manda la caja. No se valida con `Date.parse`: SQLite guarda
 * `2026-10-01 12:00:00` sin zona, y rechazar el diagnóstico por el formato de
 * una fecha sería perder el reporte entero. El admin la muestra como venga.
 */
const clientDate = text(64);

/** Lista recortada a `max` elementos (se conservan los primeros, que la caja ordena). */
const cappedArray = <T extends z.ZodTypeAny>(item: T, max: number) =>
    z.array(item).transform((items) => items.slice(0, max));

/**
 * `deviceId` es el id del documento en `posDiagnostics`: no puede llevar `/`
 * (Firestore lo tomaría como subcolección), ni ser `.`/`..` o `__x__`
 * (reservados).
 */
export const posDeviceIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !value.includes('/'), { message: 'deviceId no puede contener "/"' })
    .refine((value) => value !== '.' && value !== '..' && !/^__.*__$/.test(value), {
        message: 'deviceId inválido',
    });

const posBlockerSchema = z.object({
    kind: z.enum(['cashSession', 'product']),
    localId: text(128),
    remoteId: nullableText(128),
    label: text(),
    error: nullableText(),
    missingLocally: z.boolean(),
});

const posBlockedSaleSchema = z.object({
    localId: text(128),
    folio: text(64),
    total: z.number().finite(),
    createdAt: clientDate,
    cashSessionId: nullableText(128),
    pushError: text(),
    waitingFor: z.enum(['turno', 'catalogo', 'servidor']).nullable(),
    blockers: cappedArray(posBlockerSchema, POS_DIAGNOSTICS_LIMITS.blockersPerSale),
});

export const posDiagnosticsSchema = z.object({
    deviceId: posDeviceIdSchema,
    deviceName: text(128),
    appVersion: text(64),
    platform: text(64),
    generatedAt: clientDate,
    pendingSalesCount: z.number().int().nonnegative(),
    blockedSales: cappedArray(posBlockedSaleSchema, POS_DIAGNOSTICS_LIMITS.blockedSales),
    blockedCashSessions: cappedArray(
        z.object({
            localId: text(128),
            remoteId: nullableText(128),
            openedAt: clientDate,
            openedByLabel: nullableText(128),
            pushError: nullableText(),
            closePushError: nullableText(),
        }),
        POS_DIAGNOSTICS_LIMITS.blockedCashSessions,
    ),
    unsyncedProducts: cappedArray(
        z.object({
            localId: text(128),
            name: text(),
            pushError: nullableText(),
            catalogPushError: nullableText(),
        }),
        POS_DIAGNOSTICS_LIMITS.unsyncedProducts,
    ),
    recentSyncRuns: cappedArray(
        z.object({
            entity: text(64),
            direction: text(32),
            status: text(32),
            errorMessage: nullableText(),
            startedAt: clientDate,
        }),
        POS_DIAGNOSTICS_LIMITS.recentSyncRuns,
    ),
    syncLog: cappedArray(
        z.object({
            at: clientDate,
            level: z.enum(['info', 'warn', 'error']),
            entity: text(64),
            message: text(),
            ref: nullableText(128),
        }),
        POS_DIAGNOSTICS_LIMITS.syncLog,
    ),
});

export const posCommandTypeSchema = z.enum([
    'retrySale',
    'retryCashSession',
    'retryProduct',
    'sendSaleToUnreconciled',
]);

export const createPosCommandSchema = z.object({
    deviceId: posDeviceIdSchema,
    type: posCommandTypeSchema,
    targetLocalId: z.string().trim().min(1).max(128),
    note: z
        .string()
        .trim()
        .max(POS_TEXT_MAX)
        .nullish()
        .transform((value) => (value ? value : null)),
});

/**
 * Resultado que reporta la caja. El mensaje se recorta (puede ser un stack
 * entero) en vez de rechazarse: rechazarlo dejaría el comando `pending` para
 * siempre y la caja lo volvería a ejecutar en cada diagnóstico.
 */
export const posCommandResultSchema = z.object({
    status: z.enum(['done', 'failed']),
    message: nullableText(),
    /**
     * Caja que ejecutó el comando. Opcional solo por las cajas que aún no lo
     * mandan; si viene, debe ser la del comando: sin esto cualquier usuario con
     * `pos:write` que conociera un id podría cerrar el comando de otra caja.
     */
    deviceId: posDeviceIdSchema.optional(),
});

export const posDeviceParamSchema = z.object({
    deviceId: posDeviceIdSchema,
});

export const posCommandIdParamSchema = z.object({
    id: z.string().trim().min(1).max(128),
});
