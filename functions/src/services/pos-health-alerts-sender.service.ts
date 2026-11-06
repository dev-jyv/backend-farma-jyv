import {
    PosBlockedSalesAlertEmail,
    PosSilenceAlertEmail,
    PosStockDriftAlertEmail,
} from '../emails/pos-health-alert.email';
import * as diagnosticsRepo from '../repositories/pos-diagnostics.repository';
import { PosDiagnosticsInput, PosStockDivergence, PosStockDrift } from '../types';
import { APP_TIME_ZONE, formatLocalDateTime, getZonedYmd } from '../utils/timezone';
import { sendReportEmail } from './email.service';
import {
    BlockedSalesAlertDecision,
    POS_SILENCE_THRESHOLD_MS,
    shouldAlertSilence,
} from './pos-health-alerts.service';

/**
 * Envío de las alertas de salud de cajas (SPEC 44).
 *
 * Este módulo arrastra Resend y React Email: **solo se importa con
 * `await import()`** desde `reportDiagnostics` y desde la función programada.
 * Un import estático lo metería en el arranque en frío de `api`, que en casi
 * todos los reportes no manda nada.
 *
 * Los correos van a `REPORTS_EMAIL_TO` desde `REPORTS_EMAIL_FROM`, como el
 * resto de los reportes: no hay destinatario propio.
 */

/**
 * Hora local para el asunto: solo `HH:mm` si fue hoy (lo normal: la caja se
 * cayó esta mañana) y `dd/mm HH:mm` si fue otro día, para que una caja que no
 * reporta desde ayer no parezca caída hace un rato.
 */
export const formatLocalReportTime = (date: Date, nowDate: Date = new Date()): string => {
    const time = new Intl.DateTimeFormat('es-MX', {
        timeZone: APP_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(date);
    const sameDay = getZonedYmd(date.getTime(), APP_TIME_ZONE) ===
        getZonedYmd(nowDate.getTime(), APP_TIME_ZONE);
    if (sameDay) {
        return time;
    }
    const day = new Intl.DateTimeFormat('es-MX', {
        timeZone: APP_TIME_ZONE,
        day: '2-digit',
        month: '2-digit',
    }).format(date);
    return `${day} ${time}`;
};

/** "3 h 05 min", "45 min", "2 d 4 h". */
export const formatSilentFor = (ms: number): string => {
    const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) {
        return `${days} d ${hours} h`;
    }
    if (hours > 0) {
        return `${hours} h ${String(minutes).padStart(2, '0')} min`;
    }
    return `${minutes} min`;
};

export const silenceSubject = (deviceName: string, lastReportAt: Date, nowDate: Date): string =>
    `Caja ${deviceName} sin sincronizar desde ${formatLocalReportTime(lastReportAt, nowDate)}`;

export const blockedSalesSubject = (deviceName: string, count: number): string =>
    `Caja ${deviceName}: ${count} ventas bloqueadas`;

/**
 * Correo de ventas bloqueadas que aparecieron o crecieron. Lanza si Resend
 * falla: quien lo llama (`reportDiagnostics`) traga el error, aquí no se decide.
 */
export const sendBlockedSalesAlert = async (
    diagnostics: PosDiagnosticsInput,
    decision: BlockedSalesAlertDecision,
    reportedAt: Date = new Date(),
): Promise<void> => {
    if (!decision.shouldAlert || !decision.reason) {
        return;
    }
    const newIds = new Set(decision.newlyBlockedSaleIds);
    await sendReportEmail({
        subject: blockedSalesSubject(diagnostics.deviceName, decision.currentCount),
        react: PosBlockedSalesAlertEmail({
            deviceName: diagnostics.deviceName,
            lastReportLocal: formatLocalDateTime(reportedAt),
            reason: decision.reason,
            previousCount: decision.previousCount,
            pendingSalesCount: diagnostics.pendingSalesCount,
            blockedSales: diagnostics.blockedSales.map((sale) => ({
                localId: sale.localId,
                folio: sale.folio,
                total: sale.total,
                pushError: sale.pushError,
                isNew: newIds.has(sale.localId),
            })),
        }),
    });
};

export const stockDriftSubject = (deviceName: string, count: number): string =>
    `Caja ${deviceName}: ${count} ${count === 1 ? 'producto' : 'productos'} con stock ` +
    'distinto al servidor dos días seguidos';

/**
 * Correo de divergencia de stock repetida dos días seguidos (SPEC 67). Lanza si
 * Resend falla: quien lo llama (`reportDiagnostics`) traga el error.
 */
export const sendStockDriftAlert = async (
    diagnostics: Pick<PosDiagnosticsInput, 'deviceName'>,
    repeated: PosStockDivergence[],
    drift: PosStockDrift,
): Promise<void> => {
    if (repeated.length === 0) {
        return;
    }
    await sendReportEmail({
        subject: stockDriftSubject(diagnostics.deviceName, repeated.length),
        react: PosStockDriftAlertEmail({
            deviceName: diagnostics.deviceName,
            checkedAtLocal: formatLocalDateTime(new Date(drift.checkedAt)),
            compared: drift.compared,
            divergingToday: drift.diverging.length,
            repeated,
        }),
    });
};

export interface SilenceCheckResult {
    /** Cajas con último reporte anterior al umbral (lo que devolvió la consulta). */
    checked: number;
    /** `deviceId` de las cajas a las que se les mandó correo en esta corrida. */
    alerted: string[];
    /** `deviceId` cuyo correo falló; se reintentan en la siguiente corrida. */
    failed: string[];
}

/**
 * Revisión horaria de cajas en silencio. Una consulta (`listSilentSince`), sin
 * leer ventas. Por cada caja que amerita aviso:
 *
 * 1. marca `silenceAlertedAt` con precondición sobre la versión leída —si la
 *    caja reportó en medio, no se avisa; si dos corridas coinciden, solo una
 *    gana la marca—;
 * 2. manda el correo;
 * 3. si el correo falla, deshace la marca para reintentar en la próxima hora.
 *
 * Un fallo en una caja no detiene a las demás.
 */
export const checkSilentDevices = async (
    nowDate: Date = new Date(),
): Promise<SilenceCheckResult> => {
    const cutoff = new Date(nowDate.getTime() - POS_SILENCE_THRESHOLD_MS);
    const candidates = await diagnosticsRepo.listSilentSince(cutoff);
    const result: SilenceCheckResult = { checked: candidates.length, alerted: [], failed: [] };

    for (const candidate of candidates) {
        if (!shouldAlertSilence(candidate, nowDate.getTime())) {
            continue;
        }
        const claimedAt = await diagnosticsRepo.claimSilenceAlert(
            candidate.deviceId,
            candidate.updateTime,
        );
        if (!claimedAt) {
            continue;
        }
        try {
            await sendReportEmail({
                subject: silenceSubject(candidate.deviceName, candidate.receivedAt, nowDate),
                react: PosSilenceAlertEmail({
                    deviceName: candidate.deviceName,
                    lastReportLocal: formatLocalDateTime(candidate.receivedAt),
                    silentFor: formatSilentFor(nowDate.getTime() - candidate.receivedAt.getTime()),
                    pendingSalesCount: candidate.pendingSalesCount,
                    blockedSalesCount: candidate.blockedSalesCount,
                }),
            });
            result.alerted.push(candidate.deviceId);
        } catch (error) {
            console.error('No se pudo mandar el aviso de caja sin sincronizar', {
                deviceId: candidate.deviceId,
                error: error instanceof Error ? error.message : String(error),
            });
            result.failed.push(candidate.deviceId);
            await diagnosticsRepo
                .releaseSilenceAlert(candidate.deviceId, claimedAt)
                .catch((releaseError: unknown) => {
                    console.error('No se pudo deshacer la marca de aviso de silencio', {
                        deviceId: candidate.deviceId,
                        error: releaseError instanceof Error
                            ? releaseError.message
                            : String(releaseError),
                    });
                });
        }
    }
    return result;
};
