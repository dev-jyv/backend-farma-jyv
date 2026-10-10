import { SetMetadata } from '@nestjs/common';
import { PermissionArea, PermissionLevel } from '../../../types';

export const PERMISSION_KEY = 'permission';

export interface RequiredPermission {
    area: PermissionArea;
    level: PermissionLevel;
}

export const RequirePermission = (area: PermissionArea, level: PermissionLevel = 'write') =>
    SetMetadata(PERMISSION_KEY, { area, level });

/**
 * Basta con estar autenticado: cualquier rol activo puede llamar al handler.
 *
 * Existe para que "no hace falta permiso" sea una decisión **escrita** y no la
 * ausencia de un decorador. `PermissionsGuard` deniega todo handler sin marcar,
 * así que un endpoint nuevo al que se le olvide el decorador devuelve 403 en vez
 * de quedar abierto a cualquier usuario con sesión.
 */
export const AnyAuthenticated = () => SetMetadata(PERMISSION_KEY, ANY_AUTHENTICATED);

/** Centinela de `@AnyAuthenticated()` en el metadato `PERMISSION_KEY`. */
export const ANY_AUTHENTICATED = 'anyAuthenticated' as const;

export type PermissionMetadata = RequiredPermission | typeof ANY_AUTHENTICATED;
