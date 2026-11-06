import { Timestamp } from 'firebase-admin/firestore';
import { PosBlockedSale, PosDiagnosticsInput, PosDiagnosticsSnapshot } from '../types';
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
    const { receivedAt, reportedBy, silenceAlertedAt, ...input } = data;
    return {
        ...(input as PosDiagnosticsInput),
        // Las cajas sin actualizar (o los snapshots anteriores a SPEC 37) no lo
        // traen: el panel recibe `null`, "sin copia reportada", no un campo ausente.
        lastLocalBackupAt: (input.lastLocalBackupAt as string | null | undefined) ?? null,
        receivedAt: (receivedAt as Timestamp).toDate().toISOString(),
        reportedBy: reportedBy as string,
        // Ausente en snapshots anteriores a SPEC 44: equivale a "no se ha avisado".
        silenceAlertedAt: silenceAlertedAt
            ? (silenceAlertedAt as Timestamp).toDate().toISOString()
            : null,
    };
};

export const diagnosticsRef = (deviceId: string) => collection().doc(deviceId);

export const saveDiagnostics = async (
    input: PosDiagnosticsInput,
    reportedBy: string,
): Promise<void> => {
    // `set` sin merge a propósito: una lista que la caja ya no manda (porque se
    // destrabó) tiene que desaparecer del snapshot, no quedarse del reporte viejo.
    // `silenceAlertedAt: null` explícito: la caja volvió a reportar, así que una
    // caída posterior tiene que volver a avisar (SPEC 44).
    await diagnosticsRef(input.deviceId).set({
        ...input,
        receivedAt: now(),
        reportedBy,
        silenceAlertedAt: null,
    });
};

/**
 * Ventas bloqueadas del snapshot que está por sobrescribirse, para decidir si
 * el reporte nuevo amerita alerta (`evaluateBlockedSalesAlert`). Una lectura
 * con máscara de campos: el documento puede pesar cientos de KB por la bitácora
 * y aquí solo hace falta esta lista.
 */
export const getPreviousBlockedSales = async (
    deviceId: string,
): Promise<{ blockedSales: Pick<PosBlockedSale, 'localId'>[] } | null> => {
    const [doc] = await db().getAll(diagnosticsRef(deviceId), { fieldMask: ['blockedSales'] });
    if (!doc.exists) {
        return null;
    }
    const blockedSales = doc.get('blockedSales');
    return { blockedSales: Array.isArray(blockedSales) ? blockedSales : [] };
};

/** Lo que necesita la revisión de silencio de cada caja; sin bitácora ni corridas. */
export interface SilenceCandidate {
    deviceId: string;
    deviceName: string;
    receivedAt: Date;
    openCashSessionId: string | null | undefined;
    silenceAlertedAt: Date | null;
    pendingSalesCount: number;
    blockedSalesCount: number;
    /** Versión del documento leído: precondición para marcar el aviso. */
    updateTime: Timestamp;
}

/**
 * Cajas cuyo último reporte es anterior a `cutoff`. Una sola consulta por rango
 * de `receivedAt` (índice de un campo, automático) con máscara de campos; el
 * filtro por turno abierto y aviso ya dado se hace en memoria porque combinar
 * igualdad y rango en campos distintos pediría un índice compuesto para un
 * puñado de documentos.
 */
export const listSilentSince = async (cutoff: Date): Promise<SilenceCandidate[]> => {
    const snapshot = await collection()
        .where('receivedAt', '<', Timestamp.fromDate(cutoff))
        .select(
            'deviceId',
            'deviceName',
            'receivedAt',
            'openCashSessionId',
            'silenceAlertedAt',
            'pendingSalesCount',
            'blockedSales',
        )
        .get();
    return snapshot.docs.map((doc) => {
        const data = doc.data();
        const blockedSales = data.blockedSales;
        return {
            deviceId: (data.deviceId as string | undefined) ?? doc.id,
            deviceName: (data.deviceName as string | undefined) ?? doc.id,
            receivedAt: (data.receivedAt as Timestamp).toDate(),
            openCashSessionId: data.openCashSessionId as string | null | undefined,
            silenceAlertedAt: data.silenceAlertedAt
                ? (data.silenceAlertedAt as Timestamp).toDate()
                : null,
            pendingSalesCount: Number(data.pendingSalesCount ?? 0),
            blockedSalesCount: Array.isArray(blockedSales) ? blockedSales.length : 0,
            updateTime: doc.updateTime,
        };
    });
};

const isFailedPrecondition = (error: unknown): boolean =>
    (error as { code?: number | string }).code === 9 ||
    (error as { code?: number | string }).code === 'failed-precondition';

/**
 * Marca el aviso de silencio **solo si el snapshot no cambió** desde que se
 * leyó (`lastUpdateTime`). Si la caja reportó en medio, el reporte ya la sacó
 * del silencio y no hay que avisar: devuelve `null`. Si marca, devuelve el
 * `writeTime` para poder deshacerlo con la misma garantía.
 *
 * Marcar *antes* de mandar el correo es lo que impide que dos corridas
 * simultáneas (reintento del scheduler) avisen dos veces.
 */
export const claimSilenceAlert = async (
    deviceId: string,
    lastUpdateTime: Timestamp,
): Promise<Timestamp | null> => {
    try {
        const result = await diagnosticsRef(deviceId).update(
            { silenceAlertedAt: now() },
            { lastUpdateTime },
        );
        return result.writeTime;
    } catch (error) {
        if (isFailedPrecondition(error)) {
            return null;
        }
        throw error;
    }
};

/**
 * Deshace la marca si el correo no salió, para que la siguiente revisión lo
 * vuelva a intentar. Con precondición: si la caja ya reportó, no hay nada que
 * deshacer (el reporte la limpió).
 */
export const releaseSilenceAlert = async (
    deviceId: string,
    lastUpdateTime: Timestamp,
): Promise<void> => {
    try {
        await diagnosticsRef(deviceId).update({ silenceAlertedAt: null }, { lastUpdateTime });
    } catch (error) {
        if (!isFailedPrecondition(error)) {
            throw error;
        }
    }
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

/**
 * `deviceId` → nombre de la caja, en una sola llamada y solo con el campo
 * `deviceName` (máscara): lo usan listados y correos que citan la caja. Una caja
 * sin diagnóstico queda fuera del mapa.
 */
export const getDeviceNames = async (deviceIds: Iterable<string>): Promise<Map<string, string>> => {
    const unique = [...new Set([...deviceIds].filter(Boolean))];
    const names = new Map<string, string>();
    if (unique.length === 0) {
        return names;
    }
    const docs = await db().getAll(
        ...unique.map((deviceId) => diagnosticsRef(deviceId)),
        { fieldMask: ['deviceName'] },
    );
    for (const doc of docs) {
        const name = (doc.data()?.deviceName as string | undefined)?.trim();
        if (doc.exists && name) {
            names.set(doc.id, name);
        }
    }
    return names;
};
