import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { IS_PUBLIC_KEY } from '../src/modules/identity/decorators/public.decorator';
import {
    ANY_AUTHENTICATED,
    PERMISSION_KEY,
} from '../src/modules/identity/decorators/require-permission.decorator';
import { PermissionsGuard } from '../src/modules/identity/guards/permissions.guard';
import { AppError } from '../src/utils/errors';
import { AuthUser, RolePermission } from '../src/types';

/**
 * `PermissionsGuard` deniega por defecto: un handler sin `@RequirePermission`,
 * `@AnyAuthenticated` ni `@Public` devuelve 403.
 *
 * Estas pruebas son el trinquete de esa decisión. La primera mitad comprueba el
 * guard en sí; la segunda recorre TODAS las rutas registradas en el grafo de
 * módulos y falla si alguna no declara nada — que era el hueco original: la
 * autorización era opt-in, así que un endpoint nuevo al que se le olvidara el
 * decorador quedaba abierto a cualquier usuario con sesión, con el rol que fuera.
 */

type Handler = (...args: unknown[]) => unknown;

/** Contexto mínimo: al guard solo le importan handler, clase y `req.authUser`. */
function contextoDe(handler: Handler, clase: object, authUser?: AuthUser): ExecutionContext {
    return {
        getHandler: () => handler,
        getClass: () => clase,
        switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
    } as unknown as ExecutionContext;
}

function usuario(slug: string, permissions: RolePermission[] = []): AuthUser {
    return {
        uid: 'u1',
        email: 'x@y.z',
        role: { id: 'r1', slug, name: slug },
        permissions,
    } as unknown as AuthUser;
}

/** Handler decorado a mano, sin arrancar Nest. */
function conMetadato(valor: unknown, clave = PERMISSION_KEY): Handler {
    const handler: Handler = () => undefined;
    Reflect.defineMetadata(clave, valor, handler);
    return handler;
}

describe('PermissionsGuard', () => {
    const guard = new PermissionsGuard(new Reflector());
    class Cualquiera {}

    it('deniega un handler que no declara nada — el olvido no abre el endpoint', () => {
        const handler: Handler = () => undefined;
        expect(() => guard.canActivate(contextoDe(handler, Cualquiera, usuario('admin')))).toThrow(
            AppError,
        );
        try {
            guard.canActivate(contextoDe(handler, Cualquiera, usuario('admin')));
        } catch (error) {
            expect((error as AppError).statusCode).toBe(403);
        }
    });

    it('deja pasar @Public sin mirar el usuario', () => {
        const handler = conMetadato(true, IS_PUBLIC_KEY);
        expect(guard.canActivate(contextoDe(handler, Cualquiera, undefined))).toBe(true);
    });

    it('deja pasar @AnyAuthenticated a cualquier rol con sesión', () => {
        const handler = conMetadato(ANY_AUTHENTICATED);
        expect(guard.canActivate(contextoDe(handler, Cualquiera, usuario('doctor')))).toBe(true);
    });

    it('exige sesión incluso con @AnyAuthenticated', () => {
        const handler = conMetadato(ANY_AUTHENTICATED);
        try {
            guard.canActivate(contextoDe(handler, Cualquiera, undefined));
            fail('debía lanzar');
        } catch (error) {
            expect((error as AppError).statusCode).toBe(401);
        }
    });

    it('respeta @RequirePermission: concede con el permiso y niega sin él', () => {
        const handler = conMetadato({ area: 'expenses', level: 'read' });
        const conPermiso = usuario('manager', [{ area: 'expenses', level: 'read' }]);
        const sinPermiso = usuario('cashier', [{ area: 'sales', level: 'read' }]);

        expect(guard.canActivate(contextoDe(handler, Cualquiera, conPermiso))).toBe(true);
        try {
            guard.canActivate(contextoDe(handler, Cualquiera, sinPermiso));
            fail('debía lanzar');
        } catch (error) {
            expect((error as AppError).statusCode).toBe(403);
        }
    });
});

/** Recorre `imports` recursivamente y junta todos los `controllers`. */
function controllersDelGrafo(root: object): Function[] {
    const vistos = new Set<object>();
    const controllers: Function[] = [];

    const visitar = (modulo: unknown) => {
        if (typeof modulo !== 'function' || vistos.has(modulo)) {
            return;
        }
        vistos.add(modulo);
        for (const controller of (Reflect.getMetadata('controllers', modulo) as Function[]) ?? []) {
            if (!controllers.includes(controller)) {
                controllers.push(controller);
            }
        }
        for (const importado of (Reflect.getMetadata('imports', modulo) as unknown[]) ?? []) {
            visitar(importado);
        }
    };

    visitar(root);
    return controllers;
}

/** Handlers HTTP de un controller: los que Nest marcó con path y método. */
function rutasDe(controller: Function): { nombre: string; handler: Handler }[] {
    const proto = controller.prototype as Record<string, Handler>;
    return Object.getOwnPropertyNames(proto)
        .filter((nombre) => nombre !== 'constructor')
        .filter((nombre) => {
            const handler = proto[nombre];
            return (
                typeof handler === 'function' &&
                Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
                Reflect.getMetadata(METHOD_METADATA, handler) !== undefined
            );
        })
        .map((nombre) => ({ nombre, handler: proto[nombre] }));
}

describe('cobertura de autorización de las rutas', () => {
    const reflector = new Reflector();
    const controllers = controllersDelGrafo(AppModule);

    it('encuentra los controllers del grafo de módulos', () => {
        // Si esto baja de golpe es que el recorrido dejó de ver módulos y el
        // resto de la prueba estaría pasando en vacío.
        expect(controllers.length).toBeGreaterThanOrEqual(20);
    });

    it('toda ruta declara @RequirePermission, @AnyAuthenticated o @Public', () => {
        const sinDeclarar: string[] = [];

        for (const controller of controllers) {
            for (const { nombre, handler } of rutasDe(controller)) {
                const permiso = reflector.getAllAndOverride(PERMISSION_KEY, [handler, controller]);
                const publico = reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, controller]);
                if (permiso === undefined && !publico) {
                    sinDeclarar.push(`${controller.name}.${nombre}`);
                }
            }
        }

        expect(sinDeclarar).toEqual([]);
    });

    it('los únicos endpoints @Public son los esperados', () => {
        // Un `@Public()` nuevo tiene que ser una decisión consciente: cada uno
        // de estos se defiende por su cuenta (secreto de despliegue con
        // `timingSafeEqual`, o firma HMAC del webhook).
        const publicos: string[] = [];
        for (const controller of controllers) {
            for (const { nombre, handler } of rutasDe(controller)) {
                if (reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, controller])) {
                    publicos.push(`${controller.name}.${nombre}`);
                }
            }
        }

        expect(publicos.sort()).toEqual([
            'HealthController.getHealth',
            'InternalController.migrateRoles',
            'InternalController.triggerDailyReport',
            'InternalController.triggerInventoryAlerts',
            'InternalController.triggerMonthlyReport',
            'PaymentsController.webhook',
        ]);
    });
});
