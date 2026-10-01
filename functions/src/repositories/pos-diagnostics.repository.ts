import { Timestamp } from 'firebase-admin/firestore';
import { PosDiagnosticsInput, PosDiagnosticsSnapshot } from '../types';
import { db, now } from '../utils/firestore';

/**
 * Un documento por caja (`posDiagnostics/{deviceId}`), **sobrescrito** en cada
 * reporte: interesa el estado actual de la caja, no su historia. Guardar un
 * documento por reporte multiplicaría las escrituras por el intervalo de envío
 * de todas las cajas sin que nadie lea el histórico.
 */
const collection = () => db().collection('posDiagnostics');

/** Snapshot sin `pendingCommands`: ese dato vive en `posCommands` y lo agrega el service. */
export type StoredPosDiagnostics = Omit<PosDiagnosticsSnapshot, 'pendingCommands'>;

const mapSnapshot = (data: FirebaseFirestore.DocumentData): StoredPosDiagnostics => {
    const { receivedAt, reportedBy, ...input } = data;
    return {
        ...(input as PosDiagnosticsInput),
        receivedAt: (receivedAt as Timestamp).toDate().toISOString(),
        reportedBy: reportedBy as string,
    };
};

export const diagnosticsRef = (deviceId: string) => collection().doc(deviceId);

export const saveDiagnostics = async (
    input: PosDiagnosticsInput,
    reportedBy: string,
): Promise<void> => {
    // `set` sin merge a propósito: una lista que la caja ya no manda (porque se
    // destrabó) tiene que desaparecer del snapshot, no quedarse del reporte viejo.
    await diagnosticsRef(input.deviceId).set({
        ...input,
        receivedAt: now(),
        reportedBy,
    });
};

export const getDiagnostics = async (deviceId: string): Promise<StoredPosDiagnostics | null> => {
    const snapshot = await diagnosticsRef(deviceId).get();
    return snapshot.exists ? mapSnapshot(snapshot.data() ?? {}) : null;
};

export const mapDiagnosticsDoc = (
    doc: FirebaseFirestore.DocumentSnapshot,
): StoredPosDiagnostics | null => (doc.exists ? mapSnapshot(doc.data() ?? {}) : null);

/**
 * Todas las cajas, la más reciente primero. Sin paginar: es una fila por equipo
 * de venta (un puñado), no una colección que crezca con la operación.
 */
export const listDiagnostics = async (): Promise<StoredPosDiagnostics[]> => {
    const snapshot = await collection().orderBy('receivedAt', 'desc').get();
    return snapshot.docs.map((doc) => mapSnapshot(doc.data()));
};
