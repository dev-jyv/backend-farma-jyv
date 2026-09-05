import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { hasPermission } from '../../../constants/permissions';
import { forbidden, unauthorized } from '../../../utils/errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
    ANY_AUTHENTICATED,
    PERMISSION_KEY,
    PermissionMetadata,
} from '../decorators/require-permission.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }

        const required = this.reflector.getAllAndOverride<PermissionMetadata | undefined>(
            PERMISSION_KEY,
            [context.getHandler(), context.getClass()],
        );

        // Sin marcar = denegado. Antes esto devolvía `true`: la autorización era
        // opt-in y un endpoint nuevo al que se le olvidara el `@RequirePermission`
        // quedaba abierto a cualquier usuario autenticado, con el rol que fuera.
        // Ahora el olvido se nota en el primer intento (403) en vez de convertirse
        // en un hueco silencioso. `@AnyAuthenticated()` es la forma de decir
        // "aquí no hace falta permiso" a propósito.
        if (!required) {
            throw forbidden(
                'Este endpoint no declara permisos requeridos (@RequirePermission / @AnyAuthenticated / @Public).',
            );
        }

        const req = context.switchToHttp().getRequest<Request>();
        if (!req.authUser) {
            throw unauthorized();
        }

        if (required === ANY_AUTHENTICATED) {
            return true;
        }

        const allowed = hasPermission(
            req.authUser.permissions,
            required.area,
            required.level,
            req.authUser.role.slug,
        );
        if (!allowed) {
            throw forbidden();
        }

        return true;
    }
}
