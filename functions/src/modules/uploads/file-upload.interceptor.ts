import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import Busboy from 'busboy';
import { Request } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { ALLOWED_UPLOAD_MIME_MESSAGE, ALLOWED_UPLOAD_MIME_TYPES } from '../../constants/uploads';
import { badRequest } from '../../utils/errors';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const FIELD_NAME = 'file';

const parseMultipartFile = (req: Request): Promise<Express.Multer.File> => new Promise(
    (resolve, reject) => {
        const busboy = Busboy({
            headers: req.headers,
            limits: { fileSize: MAX_FILE_SIZE, files: 1 },
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
                settled = true;
                resolve({
                    fieldname: name,
                    originalname: filename,
                    encoding,
                    mimetype: mimeType,
                    size,
                    buffer: Buffer.concat(chunks),
                    stream,
                    destination: '',
                    filename,
                    path: '',
                });
            });
        });

        busboy.on('error', fail);
        busboy.on('filesLimit', () => fail(badRequest('Solo se permite un archivo')));
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
