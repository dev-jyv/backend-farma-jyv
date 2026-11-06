import { recordAudit, AuditActor } from './audit.service';
import {
    BlockedSalesAlertDecision,
    compareStockSample,
    comparableSample,
    evaluateBlockedSalesAlert,
    isStockDriftFromToday,
    repeatedStockDivergences,
} from './pos-health-alerts.service';
import { getPosMinVersion } from '../config/env';
import * as diagnosticsRepo from '../repositories/pos-diagnostics.repository';
import * as commandsRepo from '../repositories/pos-commands.repository';
import * as productsRepo from '../repositories/products.repository';
import * as usersRepo from '../repositories/users.repository';
import {
    PosCommand,
    PosCommandType,
    PosDiagnosticsInput,
    PosDiagnosticsSnapshot,
    PosStockDivergence,
    PosStockDrift,
    PosStockSampleItem,
} from '../types';
import { conflict, notFound } from '../utils/errors';
import { db, now } from '../utils/firestore';
import { isVersionBelow } from '../utils/version';

/**
 * Salud de cajas: la caja sube su diagnóstico y recoge en la misma respuesta
 * los comandos que el admin le dejó encolados.
 *
 * Existe porque el POS es local-first: una venta que espera un turno o un
 * producto sin `remoteId` se queda bloqueada en el SQLite del equipo y, hasta
 * ahora, el servidor no tenía forma de enterarse. Ver el diagnóstico no basta
 * —el admin no tiene acceso físico a la caja—, de ahí los comandos remotos.
 */

/**
 * Firestore admite documentos de hasta 1 MiB. Los límites del schema ya acotan
 * el caso normal, pero el peor caso teórico (todas las listas llenas con
 * textos de 500 caracteres) lo rebasa. Se mide con JSON, que sobreestima un
 * poco el tamaño real en Firestore: el margen va a favor.
 */
export const MAX_DIAGNOSTICS_BYTES = 900_000;

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Si el diagnóstico no cabe en un documento, se recorta en orden de lo menos a
 * lo más valioso: primero la bitácora y las corridas de sincronización (contexto),
 * al final las ventas bloqueadas (el motivo de todo esto). Rechazarlo dejaría
 * al servidor sin ver justo la caja que peor está.
 */
export const fitDiagnosticsToDocument = (
    input: PosDiagnosticsInput,
    maxBytes = MAX_DIAGNOSTICS_BYTES,
): PosDiagnosticsInput => {
    const originalBytes = sizeOf(input);
    if (originalBytes <= maxBytes) {
        return input;
    }

    const fitted: PosDiagnosticsInput = { ...input };
    const lists: Array<keyof Pick<PosDiagnosticsInput,
        'syncLog' | 'recentSyncRuns' | 'unsyncedProducts' | 'blockedCashSessions' | 'blockedSales'
    >> = ['syncLog', 'recentSyncRuns', 'unsyncedProducts', 'blockedCashSessions', 'blockedSales'];

    for (const key of lists) {
        while (sizeOf(fitted) > maxBytes && fitted[key].length > 0) {
            // Se conservan los primeros: la caja los manda ordenados por relevancia.
            (fitted[key] as unknown[]) = fitted[key].slice(0, Math.floor(fitted[key].length / 2));
        }
    }

    console.warn('Diagnóstico de caja recortado para caber en el documento', {
        deviceId: input.deviceId,
        originalBytes,
        fittedBytes: sizeOf(fitted),
    });
    return fitted;
};

/**
 * Tope de espera del correo de ventas bloqueadas dentro de un reporte. El envío
 * se espera (en Cloud Functions el trabajo que sigue después de responder no
 * tiene CPU garantizada y el correo podría no salir nunca), pero acotado: la
 * caja no debe quedarse colgada porque Resend tarde. Pasado el tope se responde
 * y el envío sigue por su cuenta.
 */
export const BLOCKED_SALES_ALERT_TIMEOUT_MS = 5_000;

/**
 * Manda una alerta de cajas **sin poder fallar**: cualquier error (Resend
 * caído, variable sin configurar, la propia carga del módulo) se queda en el
 * log, igual que `recordAudit`. La cadena de correo se importa dentro de `send`
 * para no cargarla en el arranque en frío de `api`. La espera se acota a
 * `BLOCKED_SALES_ALERT_TIMEOUT_MS`: pasado el tope se responde a la caja.
 */
const notifyBounded = async (
    label: string,
    deviceId: string,
    send: () => Promise<void>,
): Promise<void> => {
    const sending = send().catch((error: unknown) => {
        console.error(`No se pudo mandar la alerta de ${label}`, {
            deviceId,
            error: error instanceof Error ? error.message : String(error),
        });
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            console.warn(`La alerta de ${label} tardó más del tope; se responde igual`, {
                deviceId,
            });
            resolve();
        }, BLOCKED_SALES_ALERT_TIMEOUT_MS);
    });
    try {
        await Promise.race([sending, timeout]);
    } finally {
        clearTimeout(timer);
    }
};

const notifyBlockedSales = (
    input: PosDiagnosticsInput,
    decision: BlockedSalesAlertDecision,
    reportedAt: Date,
): Promise<void> => notifyBounded('ventas bloqueadas', input.deviceId, async () => {
    const { sendBlockedSalesAlert } = await import('./pos-health-alerts-sender.service');
    await sendBlockedSalesAlert(input, decision, reportedAt);
});

/** SPEC 67: misma divergencia de stock dos días seguidos, al correo de alertas de cajas. */
const notifyStockDrift = (
    input: PosDiagnosticsInput,
    repeated: PosStockDivergence[],
    drift: PosStockDrift,
): Promise<void> => notifyBounded('stock divergente', input.deviceId, async () => {
    const { sendStockDriftAlert } = await import('./pos-health-alerts-sender.service');
    await sendStockDriftAlert(input, repeated, drift);
});

/**
 * Compara la muestra de stock contra el servidor (SPEC 67), **a lo más una vez
 * por caja al día**: si el snapshot previo ya trae una comparación de hoy, se
 * conserva esa y no se lee nada. Sin muestra (POS viejo, o cualquier reporte
 * que no sea el de la mañana) se arrastra la comparación anterior, porque el
 * snapshot se sobrescribe completo en cada reporte.
 */
const resolveStockDrift = async (
    sample: PosStockSampleItem[] | undefined,
    previous: PosStockDrift | null,
    nowDate: Date,
): Promise<{ drift: PosStockDrift | null; compared: boolean }> => {
    if (!sample || isStockDriftFromToday(previous, nowDate)) {
        return { drift: previous, compared: false };
    }
    const items = comparableSample(sample);
    const server = await productsRepo.getStockByIds(items.map((item) => item.productId));
    return { drift: compareStockSample(items, server, nowDate), compared: true };
};

/**
 * `POST /pos/diagnostics`. Lee el snapshot previo (solo `blockedSales`, 1
 * lectura) en paralelo con los comandos pendientes, lo sobrescribe y, si las
 * ventas bloqueadas aparecieron o crecieron (`evaluateBlockedSalesAlert`),
 * avisa por correo. El correo no puede tumbar el reporte: la caja recibe 200
 * aunque Resend esté caído.
 *
 * La alerta va **después** de guardar: si la escritura falla, la caja
 * reintenta y el aviso sale con ese reintento, no dos veces.
 */
export const reportDiagnostics = async (
    input: PosDiagnosticsInput,
    reportedBy: string,
): Promise<{ commands: PosCommand[] }> => {
    // La muestra de stock no se guarda: solo su comparación (`stockDrift`).
    const { stockSample, ...report } = input;
    const fitted = fitDiagnosticsToDocument(report);
    const [previous, commands] = await Promise.all([
        diagnosticsRepo.getPreviousReportState(input.deviceId),
        commandsRepo.listPendingForDevice(input.deviceId),
    ]);
    const nowDate = new Date();
    const stock = await resolveStockDrift(stockSample, previous?.stockDrift ?? null, nowDate);
    await diagnosticsRepo.saveDiagnostics({ ...fitted, stockDrift: stock.drift }, reportedBy);

    const decision = evaluateBlockedSalesAlert(previous, fitted);
    if (decision.shouldAlert) {
        await notifyBlockedSales(fitted, decision, nowDate);
    }
    if (stock.compared && stock.drift) {
        const repeated = repeatedStockDivergences(previous?.stockDrift, stock.drift);
        if (repeated.length > 0) {
            await notifyStockDrift(fitted, repeated, stock.drift);
        }
    }
    return { commands };
};

/** Calculado al leer: cambiar `POS_MIN_VERSION` no obliga a que las cajas reporten. */
function withMinVersion<T extends { appVersion: string }>(
    snapshot: T,
    minVersion: string | null,
): T & { belowMinVersion: boolean } {
    return { ...snapshot, belowMinVersion: isVersionBelow(snapshot.appVersion, minVersion) };
}

/**
 * uid → nombre visible, para que el panel no muestre uids. Usa el perfil
 * cacheado del guard (`getUserProfile`, 60 s), y son pocos uids distintos (los
 * cajeros de las cajas y los admins que mandan comandos). Un uid que ya no
 * existe, o una lectura que falla, queda en `null`: el nombre es cortesía y no
 * debe tumbar la pantalla.
 */
const resolveUserNames = async (uids: Iterable<string>): Promise<Map<string, string | null>> => {
    const unique = [...new Set([...uids].filter(Boolean))];
    const entries = await Promise.all(unique.map(async (uid) => {
        const profile = await usersRepo.getUserProfile(uid).catch(() => null);
        const name = profile?.displayName?.trim() || profile?.email?.trim() || null;
        return [uid, name] as const;
    }));
    return new Map(entries);
};

export const listDiagnostics = async (): Promise<PosDiagnosticsSnapshot[]> => {
    const [snapshots, pendingByDevice] = await Promise.all([
        diagnosticsRepo.listDiagnostics(),
        commandsRepo.countPendingByDevice(),
    ]);
    const names = await resolveUserNames(snapshots.map((snapshot) => snapshot.reportedBy));
    const minVersion = getPosMinVersion();
    return snapshots.map((snapshot) => withMinVersion({
        ...snapshot,
        reportedByName: names.get(snapshot.reportedBy) ?? null,
        pendingCommands: pendingByDevice.get(snapshot.deviceId) ?? 0,
    }, minVersion));
};

export const getDeviceDiagnostics = async (
    deviceId: string,
): Promise<{ snapshot: PosDiagnosticsSnapshot; commands: PosCommand[] }> => {
    const [snapshot, commands, pendingCommands] = await Promise.all([
        diagnosticsRepo.getDiagnostics(deviceId),
        commandsRepo.listRecentForDevice(deviceId),
        commandsRepo.countPendingForDevice(deviceId),
    ]);
    if (!snapshot) {
        throw notFound('Diagnóstico de la caja');
    }
    const names = await resolveUserNames([
        snapshot.reportedBy,
        ...commands.map((command) => command.createdBy),
    ]);
    return {
        snapshot: withMinVersion({
            ...snapshot,
            reportedByName: names.get(snapshot.reportedBy) ?? null,
            pendingCommands,
        }, getPosMinVersion()),
        commands: commands.map((command) => ({
            ...command,
            createdByName: names.get(command.createdBy) ?? null,
        })),
    };
};

export interface CreatePosCommandInput {
    deviceId: string;
    type: PosCommandType;
    targetLocalId: string;
    note: string | null;
}

/**
 * `POST /pos/commands`. Corre en transacción para que el "¿ya hay uno igual
 * pendiente?" y el alta no se separen: un doble clic en el admin no debe
 * encolar dos reintentos de la misma venta (la caja los ejecutaría los dos).
 * Si ya existe, devuelve ese y no audita: no se creó nada.
 */
export const createCommand = async (
    input: CreatePosCommandInput,
    actor: AuditActor,
): Promise<PosCommand> => {
    const result = await db().runTransaction(async (transaction) => {
        // Todas las lecturas antes de cualquier escritura (requisito de Firestore).
        const snapshotDoc = await transaction.get(diagnosticsRepo.diagnosticsRef(input.deviceId));
        const snapshot = diagnosticsRepo.mapDiagnosticsDoc(snapshotDoc);
        if (!snapshot) {
            // Sin diagnóstico no hay caja conocida con ese id: un comando ahí
            // se quedaría pendiente para siempre sin que nadie lo recoja.
            throw notFound('Diagnóstico de la caja');
        }

        const pending = await transaction.get(commandsRepo.pendingForDeviceQuery(input.deviceId));
        const duplicate = pending.docs.find(
            (doc) => doc.get('type') === input.type &&
                doc.get('targetLocalId') === input.targetLocalId,
        );
        if (duplicate) {
            return {
                command: commandsRepo.mapCommand(duplicate.id, duplicate.data()),
                created: false,
                deviceName: snapshot.deviceName,
            };
        }

        const ref = commandsRepo.newCommandRef();
        const data = {
            deviceId: input.deviceId,
            type: input.type,
            targetLocalId: input.targetLocalId,
            note: input.note,
            status: 'pending' as const,
            createdBy: actor.userId,
            createdAt: now(),
            completedAt: null,
            completedBy: null,
            result: null,
        };
        transaction.create(ref, data);
        return {
            command: commandsRepo.mapCommand(ref.id, data),
            created: true,
            deviceName: snapshot.deviceName,
        };
    });

    if (result.created) {
        await recordAudit({
            action: 'pos.command_created',
            entity: 'posCommand',
            entityId: result.command.id,
            summary: `Comando ${input.type} sobre ${input.targetLocalId} ` +
                `para la caja ${result.deviceName}`,
            userId: actor.userId,
            roleSlug: actor.roleSlug ?? null,
            metadata: {
                deviceId: input.deviceId,
                type: input.type,
                targetLocalId: input.targetLocalId,
                note: input.note,
            },
        });
    }
    return result.command;
};

/**
 * `POST /pos/commands/:id/result`. Idempotente: la caja puede perder la
 * respuesta y reintentar, y eso no debe convertirse en error. Lo que sí se
 * rechaza es cambiar el desenlace (`done` → `failed` o al revés): dos
 * resultados distintos para el mismo comando significan que algo se ejecutó
 * dos veces, y eso hay que verlo, no sobrescribirlo.
 */
export const completeCommand = async (
    id: string,
    input: { status: 'done' | 'failed'; message: string | null; deviceId?: string },
    completedBy: string,
): Promise<PosCommand> =>
    db().runTransaction(async (transaction) => {
        const ref = commandsRepo.commandRef(id);
        const doc = await transaction.get(ref);
        if (!doc.exists) {
            throw notFound('Comando');
        }
        const command = commandsRepo.mapCommand(doc.id, doc.data() ?? {});
        // Mismo 404 que un id inexistente: no confirma que el comando existe.
        if (input.deviceId && input.deviceId !== command.deviceId) {
            throw notFound('Comando');
        }

        if (command.status !== 'pending') {
            if (command.status === input.status) {
                return command;
            }
            throw conflict(
                `El comando ya terminó como "${command.status}"; ` +
                `no se puede marcar como "${input.status}"`,
            );
        }

        const completedAt = now();
        transaction.update(ref, {
            status: input.status,
            completedAt,
            completedBy,
            result: input.message,
        });
        return {
            ...command,
            status: input.status,
            completedAt: completedAt.toDate().toISOString(),
            result: input.message,
        };
    });
