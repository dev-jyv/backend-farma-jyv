import { randomUUID } from 'crypto';
import { getStorage } from 'firebase-admin/storage';
import { badRequest } from './errors';

export const sanitizeFileName = (fileName: string): string =>
    fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

const buildDownloadUrl = (
    bucketName: string,
    storagePath: string,
    token: string,
): string =>
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

const getDownloadToken = (customMetadata: Record<string, unknown> | undefined): string | undefined => {
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

export const assertFileExists = async (storagePath: string): Promise<void> => {
    const bucket = getStorage().bucket();
    const fileRef = bucket.file(storagePath);
    const [exists] = await fileRef.exists();
    if (!exists) {
        throw badRequest('El archivo no existe o no es válido');
    }
};

export const getFileMetadata = async (
    storagePath: string,
): Promise<{ fileName: string; mimeType: string }> => {
    const bucket = getStorage().bucket();
    const fileRef = bucket.file(storagePath);
    const [metadata] = await fileRef.getMetadata();
    const fileName = storagePath.split('/').pop() ?? storagePath;
    const mimeType = metadata.contentType ?? 'application/octet-stream';
    return { fileName, mimeType };
};
