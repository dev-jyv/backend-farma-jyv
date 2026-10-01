import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
    ALL_PERMISSION_AREAS,
    SYSTEM_ROLE_DEFINITIONS,
    buildAllWritePermissions,
    hasPermission,
} from '../src/constants/permissions';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import { PermissionsGuard } from '../src/modules/identity/guards/permissions.guard';
import { PosHealthController } from '../src/modules/pos-health/pos-health.controller';
import { AppError } from '../src/utils/errors';
import { AuthUser, PermissionArea, RolePermission } from '../src/types';

/**
 * Candado de la salud de cajas. El controller mezcla dos públicos:
 *
 * - la **caja** sube su diagnóstico y reporta resultados con `pos:write`, el
 *   permiso que ya tiene el cajero —si se lo quitáramos, la caja que más
 *   necesita reportar (la que no puede subir ventas) dejaría de hacerlo;
 * - el **admin** lee todas las cajas y encola comandos con `posHealth`, que el
 *   cajero NO tiene.
 *
 * El error caro es el silencioso: marcar un endpoint de admin con `pos` lo
 * abriría a cualquier cajero sin que nada truene.
 */

const AREA: PermissionArea = 'posHealth';

const permisosDe = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS): RolePermission[] =>
    SYSTEM_ROLE_DEFINITIONS[slug].permissions;

const usuario = (slug: string, permissions: RolePermission[]): AuthUser => ({
    uid: 'u1',
    email: 'x@y.z',
    role: { id: 'r1', slug, name: slug },
    permissions,
} as unknown as AuthUser);

const proto = PosHealthController.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
>;

const contextoDe = (nombre: string, authUser?: AuthUser): ExecutionContext => ({
    getHandler: () => proto[nombre],
    getClass: () => PosHealthController,
    switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
} as unknown as ExecutionContext);

const ENDPOINTS_CAJA = ['report', 'reportResult'];
const ENDPOINTS_ADMIN = ['list', 'get', 'createCommand'];

describe('área posHealth', () => {
    it('está en ALL_PERMISSION_AREAS (de ahí sale el enum Zod de los roles)', () => {
        expect(ALL_PERMISSION_AREAS).toContain(AREA);
    });

    it('buildAllWritePermissions la otorga en escritura (la base de admin)', () => {
        expect(buildAllWritePermissions()).toContainEqual({ area: AREA, level: 'write' });
    });

    it('admin y manager la tienen en escritura', () => {
        expect(permisosDe('admin')).toContainEqual({ area: AREA, level: 'write' });
        expect(permisosDe('manager')).toContainEqual({ area: AREA, level: 'write' });
    });

    it('cajero y doctor no la tienen en ningún nivel', () => {
        for (const slug of ['cashier', 'doctor'] as const) {
            expect(permisosDe(slug).some((permission) => permission.area === AREA)).toBe(false);
            expect(hasPermission(permisosDe(slug), AREA, 'read', slug)).toBe(false);
        }
    });
});

describe('rutas de PosHealthController', () => {
    const reflector = new Reflector();
    const metadatoDe = (nombre: string) =>
        reflector.getAllAndOverride<{ area: string; level?: string } | undefined>(
            PERMISSION_KEY,
            [proto[nombre], PosHealthController],
        );

    it('lo que llama la caja va bajo pos:write', () => {
        for (const nombre of ENDPOINTS_CAJA) {
            expect(metadatoDe(nombre)).toEqual({ area: 'pos', level: 'write' });
        }
    });

    it('leer diagnósticos es posHealth:read y encolar comandos posHealth:write', () => {
        expect(metadatoDe('list')).toEqual({ area: AREA, level: 'read' });
        expect(metadatoDe('get')).toEqual({ area: AREA, level: 'read' });
        expect(metadatoDe('createCommand')).toEqual({ area: AREA, level: 'write' });
    });
});

describe('PermissionsGuard sobre la salud de cajas', () => {
    const guard = new PermissionsGuard(new Reflector());

    const codigoDe = (nombre: string, user?: AuthUser): number | 'ok' => {
        try {
            guard.canActivate(contextoDe(nombre, user));
            return 'ok';
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            return (error as AppError).statusCode;
        }
    };

    const CAJERO = usuario('cashier', permisosDe('cashier'));

    it('el cajero sube su diagnóstico y reporta resultados', () => {
        for (const nombre of ENDPOINTS_CAJA) {
            expect(codigoDe(nombre, CAJERO)).toBe('ok');
        }
    });

    it('el cajero NO lee diagnósticos ni crea comandos (403)', () => {
        for (const nombre of ENDPOINTS_ADMIN) {
            expect(codigoDe(nombre, CAJERO)).toBe(403);
        }
    });

    it('el admin pasa todos, aun con el arreglo de permisos vacío (atajo por slug)', () => {
        const admin = usuario('admin', []);
        for (const nombre of [...ENDPOINTS_CAJA, ...ENDPOINTS_ADMIN]) {
            expect(codigoDe(nombre, admin)).toBe('ok');
        }
    });

    it('el manager pasa los endpoints de admin', () => {
        const manager = usuario('manager', permisosDe('manager'));
        for (const nombre of ENDPOINTS_ADMIN) {
            expect(codigoDe(nombre, manager)).toBe('ok');
        }
    });

    it('con posHealth:read se consulta pero no se encolan comandos', () => {
        const soloLectura = usuario('auditor', [{ area: AREA, level: 'read' }]);
        expect(codigoDe('list', soloLectura)).toBe('ok');
        expect(codigoDe('get', soloLectura)).toBe('ok');
        expect(codigoDe('createCommand', soloLectura)).toBe(403);
    });

    it('el doctor no toca nada (403)', () => {
        const doctor = usuario('doctor', permisosDe('doctor'));
        for (const nombre of [...ENDPOINTS_CAJA, ...ENDPOINTS_ADMIN]) {
            expect(codigoDe(nombre, doctor)).toBe(403);
        }
    });

    it('sin sesión responde 401', () => {
        expect(codigoDe('report', undefined)).toBe(401);
        expect(codigoDe('list', undefined)).toBe(401);
    });
});
