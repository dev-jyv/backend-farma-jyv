import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as admin from 'firebase-admin';
import { getUserProfile } from '../../../repositories/users.repository';
import { resolveActiveUserRole } from '../../../services/roles.service';
import { RolePermission, RoleSummary } from '../../../types';
import { AppError, unauthorized } from '../../../utils/errors';
import { assertSessionNotExpired } from '../../../utils/session';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

const extractToken = (header?: string): string | null => {
    if (!header?.startsWith('Bearer ')) {
        return null;
    }
    return header.slice(7);
};

/**
 * Reconstruye el rol desde los custom claims del token para evitar una lectura
 * de la colección `roles` en cada request.
 *
 * Solo se aceptan si el `roleId` **y** el `permissionsVersion` del claim
 * coinciden con los del perfil (que ya se lee en cada request, así que la
 * comprobación no cuesta lecturas extra). El `roleId` cubre la reasignación de
 * rol; la versión cubre el caso más peligroso, que es el mismo rol con menos
 * permisos: sin ella, un token emitido antes del cambio conservaba el acceso
 * retirado hasta expirar. Al no coincidir se devuelve `null` y el llamador
 * resuelve contra Firestore, que ya tiene los permisos nuevos.
 */
const roleFromClaims = (
    claims: admin.auth.DecodedIdToken,
    profile: { roleId: string; permissionsVersion?: number },
): { role: RoleSummary; permissions: RolePermission[] } | null => {
    const { roleId, roleSlug, roleName, permissions, permissionsVersion } = claims as {
        roleId?: unknown;
        roleSlug?: unknown;
        roleName?: unknown;
        permissions?: unknown;
        permissionsVersion?: unknown;
    };

    if (
        typeof roleId !== 'string' ||
        typeof roleSlug !== 'string' ||
        typeof roleName !== 'string' ||
        !Array.isArray(permissions) ||
        typeof permissionsVersion !== 'number' ||
        roleId !== profile.roleId ||
        permissionsVersion !== profile.permissionsVersion
    ) {
        return null;
    }

    return {
        role: { id: roleId, name: roleName, slug: roleSlug },
        permissions: permissions as RolePermission[],
    };
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

            const fromClaims = roleFromClaims(decoded, profile);
            const resolved = fromClaims ?? (await (async () => {
                const role = await resolveActiveUserRole({ roleId: profile.roleId });
                return {
                    role: { id: role.id, name: role.name, slug: role.slug },
                    permissions: role.permissions,
                };
            })());

            req.authUser = {
                uid: decoded.uid,
                email: profile.email,
                role: resolved.role,
                roleId: resolved.role.id,
                displayName: profile.displayName,
                permissions: resolved.permissions,
            };

            return true;
        } catch (error) {
            throw error instanceof AppError ? error : unauthorized();
        }
    }
}
