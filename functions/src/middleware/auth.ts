import { NextFunction, Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { UserRole } from '../types';
import { forbidden, unauthorized } from '../utils/errors';
import { getUserProfile } from '../repositories/users.repository';

const extractToken = (header?: string): string | null => {
    if (!header?.startsWith('Bearer ')) {
        return null;
    }
    return header.slice(7);
};

export const authenticate = async (
    req: Request,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const token = extractToken(req.headers.authorization);
        if (!token) {
            throw unauthorized();
        }

        const decoded = await admin.auth().verifyIdToken(token);
        const profile = await getUserProfile(decoded.uid);

        if (!profile || !profile.isActive) {
            throw unauthorized('Usuario no autorizado');
        }

        req.authUser = {
            uid: decoded.uid,
            email: profile.email,
            role: profile.role,
            displayName: profile.displayName,
        };

        next();
    } catch (error) {
        next(error instanceof Error && 'statusCode' in error ? error : unauthorized());
    }
};

export const requireRole = (...roles: UserRole[]) =>
    (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.authUser) {
            next(unauthorized());
            return;
        }

        if (!roles.includes(req.authUser.role)) {
            next(forbidden());
            return;
        }

        next();
    };
