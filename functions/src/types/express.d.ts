import { AuthUser } from './index';
import { UploadedFile } from './uploads';

declare global {
    namespace Express {
        interface Request {
            authUser?: AuthUser;
            rawBody?: Buffer;
            file?: UploadedFile;
        }
    }
}

export {};
