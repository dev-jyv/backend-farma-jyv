import {
    ALLOWED_UPLOAD_MIME_MESSAGE,
    ALLOWED_UPLOAD_MIME_TYPES,
} from '../constants/uploads';
import { badRequest } from '../utils/errors';
import { db } from '../utils/firestore';
import { UploadedFile } from '../types/uploads';
import { getFileUrl, invoicePrefix, sanitizeFileName, uploadFile } from '../utils/storage';

/**
 * Dónde va el archivo. `invoices` manda el comprobante a Cloudflare R2 (prefijo
 * `facturas/`); el resto sigue en Firebase Storage bajo `uploads/`.
 *
 * Es un parámetro y no un campo del multipart a propósito: el interceptor solo
 * procesa el archivo —es el que valida por *magic numbers*— y no quiero abrirlo
 * a leer campos extra. Cada destino tiene su ruta HTTP.
 */
export type UploadDestination = 'default' | 'invoices';

export const RECORD_ATTACHMENT_PURPOSE = 'record-attachment';

export const uploadFileToStorage = async (
    file: UploadedFile,
    destination: UploadDestination = 'default',
    uploadedBy?: string,
): Promise<{
    storagePath: string;
    fileName: string;
    mimeType: string;
    fileUrl: string;
}> => {
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
        throw badRequest(ALLOWED_UPLOAD_MIME_MESSAGE);
    }

    const uploadId = db().collection('uploads').doc().id;
    const fileName = sanitizeFileName(file.originalname);
    const prefix = destination === 'invoices' ? invoicePrefix() : 'uploads/';
    const storagePath = `${prefix}${uploadId}/${fileName}`;

    await uploadFile(storagePath, file.buffer, file.mimetype, {
        purpose: destination === 'invoices' ? 'invoice' : RECORD_ATTACHMENT_PURPOSE,
        ...(uploadedBy ? { uploadedBy } : {}),
    });

    const signedUrl = await getFileUrl(storagePath);

    return {
        storagePath,
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileUrl: signedUrl,
    };
};
