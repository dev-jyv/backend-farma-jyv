import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import Busboy from 'busboy';
import { Request } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ALLOWED_UPLOAD_MIME_MESSAGE, ALLOWED_UPLOAD_MIME_TYPES } from '../../constants/uploads';
import { badRequest } from '../../utils/errors';
import { UploadedFile } from '../../types/uploads';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** Campos de texto que puede traer el formulario además del archivo. */
const MAX_FIELDS = 10;
const FIELD_NAME = 'file';

/**
 * El `Content-Type` de la parte multipart lo declara el cliente — un
 * `.exe`/`.html` con ese header puesto a mano en "application/pdf" pasaba la
 * validación anterior. Aquí se confirma el tipo por los primeros bytes reales
 * del archivo (magic numbers), no por lo que el cliente dice que es.
 */
const detectRealMimeType = (buffer: Buffer): string | null => {
    if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
        return 'application/pdf';
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
        buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
    ) {
        return 'image/png';
    }
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
        return 'image/webp';
    }
    return null;
};

const parseMultipartFile = (req: Request): Promise<UploadedFile> => new Promise(
    (resolve, reject) => {
        const busboy = Busboy({
            headers: req.headers,
            /**
             * `fields` y `parts` también van acotados, no solo el archivo: sin
             * ellos, un multipart con miles de campos de texto se parseaba
             * completo antes de llegar a la validación.
             */
            limits: {
                fileSize: MAX_FILE_SIZE,
                files: 1,
                fields: MAX_FIELDS,
                parts: MAX_FIELDS + 1,
            },
        });

        let settled = false;
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };

        busboy.on('file', (name, stream, info) => {
            const { filename, encoding, mimeType } = info;

            if (name !== FIELD_NAME) {
                stream.resume();
                return;
            }

            if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
                stream.resume();
                fail(badRequest(ALLOWED_UPLOAD_MIME_MESSAGE));
                return;
            }

            const chunks: Buffer[] = [];
            let size = 0;

            stream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                size += chunk.length;
            });

            stream.on('limit', () => {
                fail(badRequest('El archivo excede el tamaño máximo de 10MB'));
            });

            stream.on('close', () => {
                if (settled) {
                    return;
                }
                const buffer = Buffer.concat(chunks);
                const realMimeType = detectRealMimeType(buffer);
                if (!realMimeType || !ALLOWED_UPLOAD_MIME_TYPES.has(realMimeType)) {
                    // `fail` marca `settled` por su cuenta. Marcarlo aquí antes de
                    // llamarlo hacía que `fail` se saliera por su propia guarda
                    // sin rechazar nunca: la promesa se quedaba colgada y la
                    // petición moría por timeout de la Function en vez de
                    // contestar 400 —justo en el camino que este control
                    // protege, subir un ejecutable con el `Content-Type` de un
                    // PDF puesto a mano.
                    fail(badRequest(ALLOWED_UPLOAD_MIME_MESSAGE));
                    return;
                }
                settled = true;
                resolve({
                    fieldname: name,
                    originalname: filename,
                    encoding,
                    // El tipo real por contenido, no el declarado por el cliente.
                    mimetype: realMimeType,
                    size,
                    buffer,
                });
            });
        });

        busboy.on('error', fail);
        busboy.on('filesLimit', () => fail(badRequest('Solo se permite un archivo')));
        busboy.on('fieldsLimit', () => fail(badRequest('La petición trae demasiados campos')));
        busboy.on('partsLimit', () => fail(badRequest('La petición trae demasiadas partes')));
        busboy.on('close', () => {
            if (!settled) {
                fail(badRequest('El archivo es requerido'));
            }
        });

        if (req.rawBody) {
            busboy.end(req.rawBody);
            return;
        }

        req.pipe(busboy);
    },
);

@Injectable()
export class FileUploadInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const req = context.switchToHttp().getRequest<Request>();

        const contentType = req.headers['content-type'];
        if (!contentType?.includes('multipart/form-data')) {
            throw badRequest('Content-Type debe ser multipart/form-data');
        }

        return from(parseMultipartFile(req)).pipe(
            switchMap((file) => {
                req.file = file;
                return next.handle();
            }),
        );
    }
}
