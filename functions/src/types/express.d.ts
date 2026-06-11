import { AuthUser } from './index';

declare global {
    namespace Express {
        interface Request {
            authUser?: AuthUser;
        }
    }
}

export {};
