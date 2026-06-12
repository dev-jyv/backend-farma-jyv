import { NextFunction, Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { hasPermission } from '../constants/permissions';
import { PermissionArea, PermissionLevel, UserProfile } from '../types';
import { forbidden, unauthorized } from '../utils/errors';
import { getUserProfile, updateUserProfile } from '../repositories/users.repository';
import { resolveActiveUserRole, syncUserClaims } from '../services/roles.service';

const extractToken = (header?: string): string | null => {
    if (!header?.startsWith('Bearer ')) {
        return null;
    }
    return header.slice(7);
};

type UserProfileWithLegacyRole = UserProfile & { role?: string };
type DecodedAuthClaims = { roleSlug?: string; role?: string };

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

        const legacyProfile = profile as UserProfileWithLegacyRole;
        const decodedClaims = decoded as DecodedAuthClaims;
        const role = await resolveActiveUserRole({
            roleId: legacyProfile.roleId,
            legacyRole: legacyProfile.role ?? decodedClaims.role,
            roleSlug: typeof decodedClaims.roleSlug === 'string'
                ? decodedClaims.roleSlug
                : undefined,
        });

        if (!legacyProfile.roleId || legacyProfile.role) {
            await updateUserProfile(decoded.uid, { roleId: role.id });
            if (legacyProfile.role) {
                await admin.firestore().collection('users').doc(decoded.uid).update({
                    role: admin.firestore.FieldValue.delete(),
                });
            }
            await syncUserClaims(decoded.uid, role.id, role.slug, role.permissions);
        }

        req.authUser = {
            uid: decoded.uid,
            email: profile.email,
            role: {
                id: role.id,
                name: role.name,
                slug: role.slug,
            },
            roleId: role.id,
            displayName: profile.displayName,
            permissions: role.permissions,
        };

        next();
    } catch (error) {
        next(error instanceof Error && 'statusCode' in error ? error : unauthorized());
    }
};

export const requirePermission = (
    area: PermissionArea,
    level: PermissionLevel = 'write',
) => (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.authUser) {
        next(unauthorized());
        return;
    }

    const allowed = hasPermission(
        req.authUser.permissions,
        area,
        level,
        req.authUser.role.slug,
    );

    if (!allowed) {
        next(forbidden());
        return;
    }

    next();
};
