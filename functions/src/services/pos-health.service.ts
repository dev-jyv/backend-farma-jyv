import { recordAudit, AuditActor } from './audit.service';
import * as diagnosticsRepo from '../repositories/pos-diagnostics.repository';
import * as commandsRepo from '../repositories/pos-commands.repository';
import {
    PosCommand,
    PosCommandType,
    PosDiagnosticsInput,
    PosDiagnosticsSnapshot,
} from '../types';
import { conflict, notFound } from '../utils/errors';
import { db, now } from '../utils/firestore';

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
 * `POST /pos/diagnostics`. Una escritura + una consulta, en paralelo: se llama
 * cada pocos minutos desde cada caja, así que no lee el snapshot anterior ni
 * corre transacción.
 */
export const reportDiagnostics = async (
    input: PosDiagnosticsInput,
    reportedBy: string,
): Promise<{ commands: PosCommand[] }> => {
    const [, commands] = await Promise.all([
        diagnosticsRepo.saveDiagnostics(fitDiagnosticsToDocument(input), reportedBy),
        commandsRepo.listPendingForDevice(input.deviceId),
    ]);
    return { commands };
};

export const listDiagnostics = async (): Promise<PosDiagnosticsSnapshot[]> => {
    const [snapshots, pendingByDevice] = await Promise.all([
        diagnosticsRepo.listDiagnostics(),
        commandsRepo.countPendingByDevice(),
    ]);
    return snapshots.map((snapshot) => ({
        ...snapshot,
        pendingCommands: pendingByDevice.get(snapshot.deviceId) ?? 0,
    }));
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
    return { snapshot: { ...snapshot, pendingCommands }, commands };
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
