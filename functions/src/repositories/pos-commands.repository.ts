import { Timestamp } from 'firebase-admin/firestore';
import { PosCommand, PosCommandStatus, PosCommandType } from '../types';
import { db } from '../utils/firestore';

/**
 * Comandos remotos del admin hacia una caja. La caja los recoge como respuesta
 * de su propio `POST /pos/diagnostics` (no hay canal de servidor a caja: el POS
 * es local-first y puede pasar horas sin red), los ejecuta contra su SQLite y
 * reporta el resultado.
 */
const collection = () => db().collection('posCommands');

/**
 * Tope de comandos pendientes que se le entregan a una caja por reporte. Un
 * puñado es lo normal; el tope solo acota el costo si alguien encola de más.
 * Los que no entren se entregan en el siguiente reporte.
 */
export const PENDING_COMMANDS_LIMIT = 100;

/** Historial que ve el admin en el detalle de una caja. */
export const RECENT_COMMANDS_LIMIT = 50;

const toIso = (value: unknown): string | null =>
    value instanceof Timestamp ? value.toDate().toISOString() : null;

export const mapCommand = (id: string, data: FirebaseFirestore.DocumentData): PosCommand => ({
    id,
    deviceId: data.deviceId as string,
    type: data.type as PosCommandType,
    targetLocalId: data.targetLocalId as string,
    note: (data.note as string | null) ?? null,
    status: data.status as PosCommandStatus,
    createdBy: data.createdBy as string,
    createdAt: toIso(data.createdAt) ?? '',
    completedAt: toIso(data.completedAt),
    result: (data.result as string | null) ?? null,
});

export const commandRef = (id: string) => collection().doc(id);

export const newCommandRef = () => collection().doc();

/** Pendientes de una caja, el más viejo primero: se ejecutan en el orden en que se pidieron. */
export const pendingForDeviceQuery = (deviceId: string) =>
    collection()
        .where('deviceId', '==', deviceId)
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc');

export const listPendingForDevice = async (deviceId: string): Promise<PosCommand[]> => {
    const snapshot = await pendingForDeviceQuery(deviceId).limit(PENDING_COMMANDS_LIMIT).get();
    return snapshot.docs.map((doc) => mapCommand(doc.id, doc.data()));
};

export const countPendingForDevice = async (deviceId: string): Promise<number> => {
    const snapshot = await collection()
        .where('deviceId', '==', deviceId)
        .where('status', '==', 'pending')
        .count()
        .get();
    return snapshot.data().count;
};

/**
 * Pendientes por caja en **una** consulta: el listado del admin lo necesita
 * por fila, y un `count()` por caja serían N consultas. La cola de pendientes
 * es chica por naturaleza (cada caja la vacía en su siguiente reporte).
 */
export const countPendingByDevice = async (): Promise<Map<string, number>> => {
    const snapshot = await collection().where('status', '==', 'pending').select('deviceId').get();
    const counts = new Map<string, number>();
    for (const doc of snapshot.docs) {
        const deviceId = doc.get('deviceId') as string;
        counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1);
    }
    return counts;
};

export const listRecentForDevice = async (deviceId: string): Promise<PosCommand[]> => {
    const snapshot = await collection()
        .where('deviceId', '==', deviceId)
        .orderBy('createdAt', 'desc')
        .limit(RECENT_COMMANDS_LIMIT)
        .get();
    return snapshot.docs.map((doc) => mapCommand(doc.id, doc.data()));
};
