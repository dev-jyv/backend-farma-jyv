import {
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getR2Config } from '../config/env';
import { badRequest } from './errors';

/**
 * Cloudflare R2 por su API compatible con S3.
 *
 * La región es `auto` y no es opcional: R2 no tiene regiones, pero el SDK de
 * AWS exige una para firmar (SigV4 la mete en la cadena de credenciales), y con
 * cualquier otra el servidor rechaza la firma.
 *
 * El cliente se construye una sola vez por instancia de la Function: Cloud
 * Functions reutiliza el proceso entre invocaciones, así que rearmarlo en cada
 * subida pagaría la resolución de credenciales una y otra vez.
 */
let client: S3Client | null = null;

const getClient = (): { s3: S3Client; bucket: string } => {
    const config = getR2Config();
    if (!config) {
        // Nunca debería llegar aquí: `storage.ts` comprueba `isR2Enabled()`
        // antes de enrutar. Si pasa, es un error de programación, no del
        // entorno, y un mensaje claro ahorra media hora de depuración.
        throw new Error(
            'R2 no está configurado: falta R2_ACCOUNT_ID/R2_BUCKET/' +
            'R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY',
        );
    }

    if (!client) {
        client = new S3Client({
            region: 'auto',
            endpoint: config.endpoint,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
        });
    }

    return { s3: client, bucket: config.bucket };
};

/** Solo para las pruebas: fuerza rearmar el cliente tras cambiar el entorno. */
export const resetR2Client = (): void => {
    client = null;
};

export const putObject = async (
    key: string,
    body: Buffer,
    contentType: string,
): Promise<void> => {
    const { s3, bucket } = getClient();
    await s3.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        }),
    );
};

/**
 * Metadatos del objeto, o `badRequest` si no existe.
 *
 * Mismo contrato que el `getFileMetadata` de Firebase Storage —una sola llamada
 * que además sirve de comprobación de existencia—, para que los llamadores no
 * tengan que saber dónde vive el archivo.
 */
export const headObject = async (
    key: string,
): Promise<{ mimeType: string }> => {
    const { s3, bucket } = getClient();
    try {
        const salida = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { mimeType: salida.ContentType ?? 'application/octet-stream' };
    } catch (error) {
        const metadatos = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
        const estado = metadatos?.httpStatusCode;
        const nombre = (error as { name?: string }).name;
        if (estado === 404 || nombre === 'NotFound' || nombre === 'NoSuchKey') {
            throw badRequest('El archivo no existe o no es válido');
        }
        throw error;
    }
};

/** Vigencia por defecto de la URL firmada: alcanza para abrir o descargar. */
const SIGNED_URL_MINUTES = 15;

/**
 * URL firmada de lectura, con caducidad.
 *
 * R2 no tiene el equivalente al token de descarga permanente de Firebase
 * Storage, y es mejor así: cuando el enlace expira deja de servir el archivo,
 * en vez de quedar accesible para siempre a quien copió la URL. El bucket debe
 * quedar **privado**; si se expone por un dominio público, esta firma sobra y
 * el comprobante queda legible por cualquiera que adivine la ruta.
 */
export const presignGetUrl = async (
    key: string,
    minutes: number = SIGNED_URL_MINUTES,
): Promise<string> => {
    const { s3, bucket } = getClient();
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: minutes * 60,
    });
};
