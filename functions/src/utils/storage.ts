import { randomUUID } from 'crypto';
import { getStorage } from 'firebase-admin/storage';
import { isR2Enabled } from '../config/env';
import { badRequest } from './errors';

/**
 * El cliente de R2 se carga **bajo demanda**, no con un import estático.
 *
 * `@aws-sdk/client-s3` cuesta ~47 ms de `require`, y este módulo está en el
 * camino de arranque de la function `api`: estático, esos milisegundos los
 * pagaba cada arranque en frío, incluidos los miles de requests que nunca tocan
 * un comprobante. Es la misma razón por la que Puppeteer y Resend tampoco se
 * importan arriba. Node cachea el módulo, así que solo la primera factura de
 * cada instancia paga la carga.
 */
const r2 = () => import('./r2');

/**
 * Prefijo de los comprobantes de factura, que viven en **Cloudflare R2**.
 *
 * El prefijo es lo que decide dónde está cada archivo, y por eso importa que
 * sea distinto del histórico `uploads/`: los comprobantes subidos antes de R2
 * siguen en Firebase Storage y tienen que seguir abriéndose. Enrutar por
 * prefijo lo resuelve sin migrar nada y sin sondear los dos proveedores.
 *
 * Lo clínico (`uploads/`) NO se mueve: es dato sensible de paciente
 * (NOM-004) y cambiarle el almacenamiento no es parte de esto.
 */
export const R2_PREFIX = 'facturas/';

/** `true` si esta ruta vive en R2. Enrutado explícito, sin sondeos. */
export const isR2Path = (storagePath: string): boolean =>
    storagePath.startsWith(R2_PREFIX);

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
    if (isR2Path(storagePath)) {
        const { putObject } = await r2();
        await putObject(storagePath, buffer, mimeType);
        return;
    }

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
    if (isR2Path(storagePath)) {
        // R2 no tiene token de descarga permanente: siempre firma con caducidad.
        const { presignGetUrl } = await r2();
        return presignGetUrl(storagePath);
    }

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
    if (isR2Path(storagePath)) {
        const { presignGetUrl } = await r2();
        return presignGetUrl(storagePath, minutes);
    }

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
    if (isR2Path(storagePath)) {
        const { headObject } = await r2();
        const { mimeType } = await headObject(storagePath);
        return { fileName: storagePath.split('/').pop() ?? storagePath, mimeType };
    }

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


/**
 * Prefijo con el que se guarda un comprobante de factura **nuevo**.
 *
 * Con R2 configurado va a `facturas/`; sin configurar cae en `uploads/`, o sea
 * Firebase Storage. Preferible a tumbar la caja porque un secreto no está
 * puesto: la factura se registra igual y el archivo queda donde se pueda leer.
 * `isR2Path` se encarga de que cada objeto se lea de donde de verdad está.
 */
export const invoicePrefix = (): string => (isR2Enabled() ? R2_PREFIX : 'uploads/');
