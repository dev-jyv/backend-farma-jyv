import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as admin from 'firebase-admin';
import { getUserProfile, updateUserProfile } from '../../../repositories/users.repository';
import { resolveActiveUserRole, syncUserClaims } from '../../../services/roles.service';
import { UserProfile } from '../../../types';
import { AppError, unauthorized } from '../../../utils/errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

type UserProfileWithLegacyRole = UserProfile & { role?: string };
type DecodedAuthClaims = { roleSlug?: string; role?: string };

const extractToken = (header?: string): string | null => {
    if (!header?.startsWith('Bearer ')) {
        return null;
    }
    return header.slice(7);
};

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }

        const req = context.switchToHttp().getRequest<Request>();

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

            return true;
        } catch (error) {
            throw error instanceof AppError ? error : unauthorized();
        }
    }
}
