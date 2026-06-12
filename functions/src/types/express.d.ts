import { AuthUser } from './index';

declare global {
    namespace Express {
        interface Request {
            authUser?: AuthUser;
            rawBody?: Buffer;
            file?: Express.Multer.File;
        }
    }
}

export {};
