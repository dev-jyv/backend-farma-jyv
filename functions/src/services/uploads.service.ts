import {
    ALLOWED_UPLOAD_MIME_MESSAGE,
    ALLOWED_UPLOAD_MIME_TYPES,
} from '../constants/uploads';
import { badRequest } from '../utils/errors';
import { db } from '../utils/firestore';
import { UploadedFile } from '../types/uploads';
import { getFileUrl, sanitizeFileName, uploadFile } from '../utils/storage';

export const uploadFileToStorage = async (
    file: UploadedFile,
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
    const storagePath = `uploads/${uploadId}/${fileName}`;

    await uploadFile(storagePath, file.buffer, file.mimetype);

    const signedUrl = await getFileUrl(storagePath);

    return {
        storagePath,
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileUrl: signedUrl,
    };
};
