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

/** Metadato de `@RequireAnyPermission()`: basta con cumplir una de las opciones. */
export interface AnyOfPermissions {
    anyOf: RequiredPermission[];
}

/**
 * Pasa si el usuario cumple **alguna** de las opciones (cada una evaluada con
 * `hasPermission`, así que el admin pasa siempre). Existe para rutas que dos
 * áreas distintas pueden abrir —p. ej. los exportes, que abre `dashboard:read`
 * y también `reportDownloads:read` del contador—, sin abrirlas a cualquiera.
 * Lo que cada área puede hacer *dentro* de la ruta lo sigue decidiendo el
 * servicio; el decorador solo deja entrar.
 */
export const RequireAnyPermission = (...options: RequiredPermission[]) => {
    if (options.length === 0) {
        throw new Error('@RequireAnyPermission necesita al menos una opción');
    }
    return SetMetadata(PERMISSION_KEY, { anyOf: options } satisfies AnyOfPermissions);
};

export const isAnyOfPermissions = (value: unknown): value is AnyOfPermissions =>
    typeof value === 'object' && value !== null &&
    Array.isArray((value as AnyOfPermissions).anyOf);

export type PermissionMetadata =
    | RequiredPermission
    | AnyOfPermissions
    | typeof ANY_AUTHENTICATED;
