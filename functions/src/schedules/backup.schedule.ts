import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REPORTS_TIME_ZONE } from '../services/sales-reports.service';

/**
 * Respaldo diario de Firestore a Cloud Storage.
 *
 * Existe porque hasta ahora un borrado accidental no tenía vuelta atrás: los
 * datos viven en una sola base y nadie los copiaba a ningún lado. La exportación
 * nativa de Firestore deja un volcado consistente que se puede reimportar entero
 * o por colección.
 *
 * Corre a las 02:00, cuando la farmacia está cerrada: la exportación consume
 * cuota de lectura y compite con la operación si se lanza en horario de venta.
 *
 * **La retención no se administra aquí.** Se configura como regla de ciclo de
 * vida del bucket (borrar objetos con más de N días); resolverla con código
 * obligaría a listar y borrar objetos desde la función, que es justo la clase de
 * operación destructiva que no debe vivir en un cron sin supervisión.
 */

/**
 * Bucket destino, sin `gs://`. Sin esta variable la función no corre: adivinar
 * el bucket podría escribir el volcado —que contiene la base completa— en uno
 * con permisos distintos a los que se pensaron para él.
 */
const getBackupBucket = (): string => {
    const bucket = process.env.FIRESTORE_BACKUP_BUCKET?.trim();
    if (!bucket) {
        throw new Error(
            'FIRESTORE_BACKUP_BUCKET no está configurado: el respaldo no sabe dónde escribir',
        );
    }
    return bucket.replace(/^gs:\/\//, '').replace(/\/+$/, '');
};

/** `firestore-backups/2026-09-17T02-00-00` — ordenable y legible en la consola. */
const backupPrefix = (now: Date): string =>
    `firestore-backups/${now.toISOString().replace(/:/g, '-').slice(0, 19)}`;

export const dailyFirestoreBackup = onSchedule(
    {
        region: 'us-central1',
        timeZone: REPORTS_TIME_ZONE,
        memory: '256MiB',
        // La llamada solo **lanza** la exportación y devuelve la operación; el
        // volcado corre del lado de Google, así que la función no espera a que
        // termine y no necesita un timeout largo.
        timeoutSeconds: 120,
        schedule: '0 2 * * *',
        retryCount: 1,
    },
    async () => {
        const bucket = getBackupBucket();
        const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
        if (!projectId) {
            throw new Error('No se pudo resolver el proyecto para el respaldo');
        }

        // Import dentro del handler, igual que los reportes: `index.ts` reexporta
        // este módulo y un import estático cargaría el cliente admin en el
        // arranque en frío de la API, que nunca respalda nada.
        const { v1 } = await import('@google-cloud/firestore');
        const client = new v1.FirestoreAdminClient();

        const name = client.databasePath(projectId, '(default)');
        const outputUriPrefix = `gs://${bucket}/${backupPrefix(new Date())}`;

        // Sin `collectionIds`: la base entera. Respaldar una lista de colecciones
        // significa que cada colección nueva nace sin respaldo hasta que alguien
        // se acuerde de agregarla aquí, y nadie se acuerda.
        const [operation] = await client.exportDocuments({ name, outputUriPrefix });

        console.log(`Respaldo de Firestore lanzado: ${outputUriPrefix} (${operation.name})`);
    },
);
