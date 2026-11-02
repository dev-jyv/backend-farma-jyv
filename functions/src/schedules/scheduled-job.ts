import * as logger from 'firebase-functions/logger';

/**
 * Registro estructurado del final de cada función programada (SPEC 32).
 *
 * Las alertas de operación no pueden depender del texto libre de un
 * `console.log`: una métrica basada en log (`farmajyv_scheduled_job_runs`, ver
 * `scripts/ops/defs/logging/metric-scheduled-job-runs.json`) cuenta estas
 * entradas por `job` y `outcome`, y sobre ella se montan dos tipos de política:
 *
 * - **fallo definitivo**: más intentos fallidos que `retryCount` en una hora. Un
 *   primer intento fallido seguido de un reintento exitoso no alerta.
 * - **ausencia**: `dailyFirestoreBackup` sin un `succeeded` en 26 h, aunque no
 *   haya ningún log de error (la función ni siquiera corrió).
 *
 * Cambiar `event`, `job` u `outcome` rompe esas políticas en silencio: si se
 * tocan, actualizar la métrica y el RUNBOOK §7 en el mismo cambio.
 */

export const SCHEDULED_JOB_EVENT = 'scheduled_job.finished';

export type ScheduledJobOutcome = 'succeeded' | 'failed';

/** Lo que la tarea quiera dejar en el log de éxito (p. ej. el destino del respaldo). */
export type ScheduledJobDetail = Record<string, unknown> | void;

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Corre `task` y deja una sola entrada `scheduled_job.finished` con el resultado.
 *
 * El error se **relanza**: Cloud Scheduler decide el reintento según la
 * respuesta de la función, así que tragárselo apagaría el `retryCount`. El
 * intento fallido se registra como `warn` y no como `error` porque todavía puede
 * haber reintento; quien decide si es definitivo es la política de alerta.
 */
export const runScheduledJob = async (
    job: string,
    task: () => Promise<ScheduledJobDetail>,
): Promise<void> => {
    const startedAt = Date.now();
    let detail: ScheduledJobDetail;
    try {
        detail = await task();
    } catch (error) {
        logger.warn(`Función programada ${job}: intento fallido`, {
            event: SCHEDULED_JOB_EVENT,
            job,
            outcome: 'failed' satisfies ScheduledJobOutcome,
            durationMs: Date.now() - startedAt,
            error: errorMessage(error),
        });
        throw error;
    }

    logger.info(`Función programada ${job}: terminó bien`, {
        ...(detail ?? {}),
        event: SCHEDULED_JOB_EVENT,
        job,
        outcome: 'succeeded' satisfies ScheduledJobOutcome,
        durationMs: Date.now() - startedAt,
    });
};

/**
 * Envuelve el handler de un `onSchedule`. `job` debe ser **el nombre exportado**
 * de la función: es la etiqueta que muestran las alertas y la que las políticas
 * filtran (`scripts/ops/scheduled-jobs.json`).
 */
export const monitoredJob =
    <E>(job: string, handler: (event: E) => Promise<ScheduledJobDetail>) =>
        (event: E): Promise<void> =>
            runScheduledJob(job, () => handler(event));
