import { randomUUID } from 'crypto';
import { getStorage } from 'firebase-admin/storage';
import { badRequest } from './errors';

/** Nombre de reemplazo cuando el que manda el cliente no deja nada usable. */
const FALLBACK_FILE_NAME = 'archivo';
/**
 * Tope del último segmento del nombre del objeto. Google Cloud Storage acota el
 * nombre completo a 1024 bytes: sin tope, un `originalname` de miles de
 * caracteres (que nada valida antes) hacía fallar la subida ya con el archivo
 * en memoria.
 */
const MAX_FILE_NAME_LENGTH = 120;
/** Más allá de esto no es una extensión, es parte del nombre. */
const MAX_EXTENSION_LENGTH = 12;

/**
 * Deja el nombre del cliente en **un solo segmento inofensivo** de la ruta del
 * objeto.
 *
 * Reemplazar todo lo que no sea `[A-Za-z0-9._-]` ya elimina `/`, `\`, los bytes
 * de control y el `%2f` decodificado, así que `../../etc/passwd` no puede salir
 * del prefijo. Lo que faltaba era el nombre formado **solo por puntos**: `..`
 * sobrevivía intacto al reemplazo y `uploads/<id>/..` nombra el directorio
 * padre, no un archivo; `.` y la cadena vacía dejaban la ruta terminada en `/`.
 */
export const sanitizeFileName = (fileName: string): string => {
    const cleaned = (fileName ?? '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        // Solo puntos (`.`, `..`, `...`) no nombra un archivo: nombra una ruta.
        .replace(/^\.+$/, '');

    if (!cleaned) {
        return FALLBACK_FILE_NAME;
    }
    if (cleaned.length <= MAX_FILE_NAME_LENGTH) {
        return cleaned;
    }

    // Se recorta por delante para conservar la extensión: es lo que decide con
    // qué aplicación abre el comprobante quien lo descarga.
    const dot = cleaned.lastIndexOf('.');
    const extension = dot > 0 && cleaned.length - dot <= MAX_EXTENSION_LENGTH
        ? cleaned.slice(dot)
        : '';
    return cleaned.slice(0, MAX_FILE_NAME_LENGTH - extension.length) + extension;
};

const buildDownloadUrl = (
    bucketName: string,
    storagePath: string,
    token: string,
): string =>
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}` +
    `/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

const getDownloadToken = (
    customMetadata: Record<string, unknown> | undefined,
): string | undefined => {
    const tokens = customMetadata?.firebaseStorageDownloadTokens;
    return typeof tokens === 'string' ? tokens.split(',')[0] : undefined;
};

export const uploadFile = async (
    storagePath: string,
    buffer: Buffer,
    mimeType: string,
): Promise<void> => {
    const bucket = getStorage().bucket();
    const fileRef = bucket.file(storagePath);
    const downloadToken = randomUUID();

    await fileRef.save(buffer, {
        // Subida simple: el interceptor acota el archivo a 10 MB y la subida
        // reanudable gasta una petición extra solo en abrir la sesión.
        resumable: false,
        metadata: {
            contentType: mimeType,
            metadata: {
                firebaseStorageDownloadTokens: downloadToken,
            },
        },
    });
};

export const getFileUrl = async (storagePath: string): Promise<string> => {
    const bucket = getStorage().bucket();
    const fileRef = bucket.file(storagePath);
    const [metadata] = await fileRef.getMetadata();

    let token = getDownloadToken(metadata.metadata as Record<string, unknown> | undefined);
    if (!token) {
        token = randomUUID();
        await fileRef.setMetadata({
            metadata: {
                ...metadata.metadata,
                firebaseStorageDownloadTokens: token,
            },
        });
    }

    return buildDownloadUrl(bucket.name, storagePath, token);
};

/** Vigencia por defecto de una URL firmada: alcanza para abrir o descargar. */
const SIGNED_URL_MINUTES = 15;

/**
 * URL firmada v4 de lectura, con caducidad. A diferencia de `getFileUrl`, no
 * deja un token de descarga permanente en el objeto: cuando expira, el enlace
 * deja de servir el archivo. Es lo que debe usar todo lo clínico — un estudio
 * del expediente no puede quedar accesible para siempre a quien copió la URL.
 *
 * Requiere que la cuenta de servicio de la Function pueda firmar
 * (`roles/iam.serviceAccountTokenCreator`); sin ese permiso, `getSignedUrl`
 * falla con `SigningError`.
 */
export const getSignedFileUrl = async (
    storagePath: string,
    minutes: number = SIGNED_URL_MINUTES,
): Promise<string> => {
    const bucket = getStorage().bucket();
    const [url] = await bucket.file(storagePath).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + minutes * 60 * 1000,
    });
    return url;
};

/**
 * Verifica que el archivo exista y devuelve sus datos en **una sola** llamada a
 * Storage.
 *
 * Antes eran dos (`exists()` y luego `getMetadata()`), y todos los llamadores
 * las hacían seguidas: `getMetadata()` ya falla con 404 si el objeto no está,
 * así que el `exists()` era un viaje de red de más por cada archivo —y los
 * adjuntos del expediente se resuelven en paralelo, uno por adjunto.
 */
export const getFileMetadata = async (
    storagePath: string,
): Promise<{ fileName: string; mimeType: string }> => {
    const fileRef = getStorage().bucket().file(storagePath);

    let metadata: { contentType?: string | null };
    try {
        [metadata] = await fileRef.getMetadata();
    } catch (error) {
        if ((error as { code?: number }).code === 404) {
            throw badRequest('El archivo no existe o no es válido');
        }
        throw error;
    }

    return {
        fileName: storagePath.split('/').pop() ?? storagePath,
        mimeType: metadata.contentType ?? 'application/octet-stream',
    };
};

