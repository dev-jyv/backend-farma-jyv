import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as admin from 'firebase-admin';
import { getUserProfile } from '../../../repositories/users.repository';
import { resolveActiveUserRole } from '../../../services/roles.service';
import { AppError, unauthorized } from '../../../utils/errors';
import { assertSessionNotExpired } from '../../../utils/session';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

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
            assertSessionNotExpired(decoded.auth_time);
            const profile = await getUserProfile(decoded.uid);

            if (!profile || !profile.isActive || !profile.roleId) {
                throw unauthorized('Usuario no autorizado');
            }

            const role = await resolveActiveUserRole({
                roleId: profile.roleId,
            });

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
