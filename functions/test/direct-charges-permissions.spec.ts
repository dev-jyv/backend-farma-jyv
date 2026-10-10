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
import { DirectChargesController } from '../src/modules/direct-charges/direct-charges.controller';
import { PermissionsGuard } from '../src/modules/identity/guards/permissions.guard';
import { AppError } from '../src/utils/errors';
import { AuthUser, PermissionArea, RolePermission } from '../src/types';

/**
 * Candado del área `directCharges`.
 *
 * Cobrar por terminal **fuera del ticket** no es una atribución de mostrador: no
 * deja rastro en el inventario ni en el corte de caja, así que un cobro directo
 * es dinero que entra sin nada con qué cuadrarlo. Es una operación de
 * supervisión, y por eso el rol `cashier` no la tiene aunque sí tenga `pos` en
 * escritura para cobrar con la misma terminal dentro de una venta.
 *
 * `manager` sí la tiene: se define como "todo menos unas pocas áreas", y aquí la
 * herencia es la intención, no un descuido. Estas pruebas fijan las dos cosas,
 * porque el error caro es el silencioso —agregar `directCharges` a `cashier` de
 * pasada no rompe nada visible.
 */

const AREA: PermissionArea = 'directCharges';

const permisosDe = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS): RolePermission[] =>
    SYSTEM_ROLE_DEFINITIONS[slug].permissions;

describe('ALL_PERMISSION_AREAS', () => {
    it('incluye el área directCharges', () => {
        expect(ALL_PERMISSION_AREAS).toContain(AREA);
    });

    it('buildAllWritePermissions la otorga en escritura (la base de admin)', () => {
        expect(buildAllWritePermissions()).toContainEqual({ area: AREA, level: 'write' });
    });
});

describe('rol cashier', () => {
    it('NO tiene el área: cobrar fuera del ticket no es del mostrador', () => {
        expect(permisosDe('cashier').map((permission) => permission.area)).not.toContain(AREA);
    });

    it('no la tiene ni en lectura: no consulta cobros que no puede hacer', () => {
        expect(hasPermission(permisosDe('cashier'), AREA, 'read', 'cashier')).toBe(false);
        expect(hasPermission(permisosDe('cashier'), AREA, 'write', 'cashier')).toBe(false);
    });

    it('sí conserva `pos` en escritura: cobra con la terminal dentro de una venta', () => {
        // El candado de arriba no debe leerse como "el cajero no cobra con
        // terminal": cobra, pero contra un ticket.
        expect(permisosDe('cashier')).toContainEqual({ area: 'pos', level: 'write' });
    });
});

describe('rol doctor', () => {
    it('no tiene el área: el consultorio no cobra por su cuenta', () => {
        expect(permisosDe('doctor').map((permission) => permission.area)).not.toContain(AREA);
        expect(hasPermission(permisosDe('doctor'), AREA, 'read', 'doctor')).toBe(false);
    });
});

describe('roles con el área', () => {
    it('admin la tiene en escritura', () => {
        expect(hasPermission(permisosDe('admin'), AREA, 'write', 'admin')).toBe(true);
    });

    it('manager la tiene en escritura: es la atribución de supervisión', () => {
        expect(permisosDe('manager')).toContainEqual({ area: AREA, level: 'write' });
        expect(hasPermission(permisosDe('manager'), AREA, 'write', 'manager')).toBe(true);
    });

    it('solo admin y manager la tienen entre los roles de sistema', () => {
        const conElArea = Object.keys(SYSTEM_ROLE_DEFINITIONS).filter((slug) =>
            hasPermission(
                permisosDe(slug as keyof typeof SYSTEM_ROLE_DEFINITIONS),
                AREA,
                'read',
                slug,
            ),
        );
        expect(conElArea.sort()).toEqual(['admin', 'manager']);
    });
});

/** Contexto mínimo: al guard solo le importan handler, clase y `req.authUser`. */
const contextoDe = (
    handler: (...args: unknown[]) => unknown,
    authUser?: AuthUser,
): ExecutionContext => ({
    getHandler: () => handler,
    getClass: () => DirectChargesController,
    switchToHttp: () => ({ getRequest: () => ({ authUser }) }),
} as unknown as ExecutionContext);

const usuario = (slug: string, permissions: RolePermission[]): AuthUser => ({
    uid: 'u1',
    email: 'x@y.z',
    role: { id: 'r1', slug, name: slug },
    permissions,
} as unknown as AuthUser);

type Ruta = { nombre: keyof DirectChargesController; area: string; level: string };

describe('rutas de DirectChargesController', () => {
    const reflector = new Reflector();
    const proto = DirectChargesController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >;

    const metadatoDe = (nombre: string) =>
        reflector.getAllAndOverride<{ area: string; level?: string } | undefined>(
            PERMISSION_KEY,
            [proto[nombre], DirectChargesController],
        );

    const RUTAS: Ruta[] = [
        { nombre: 'create', area: AREA, level: 'write' },
        { nombre: 'createOnline', area: AREA, level: 'write' },
        { nombre: 'list', area: AREA, level: 'read' },
        { nombre: 'get', area: AREA, level: 'read' },
        { nombre: 'cancel', area: AREA, level: 'write' },
    ];

    it('los cinco endpoints declaran el área directCharges', () => {
        for (const ruta of RUTAS) {
            expect(metadatoDe(ruta.nombre)?.area).toBe(AREA);
        }
    });

    it('crear y cancelar exigen escritura; consultar se conforma con lectura', () => {
        // `level` ausente significa `write` en `@RequirePermission`.
        for (const ruta of RUTAS) {
            expect(metadatoDe(ruta.nombre)?.level ?? 'write').toBe(ruta.level);
        }
    });

    it('ningún endpoint quedó sin declarar permisos', () => {
        for (const ruta of RUTAS) {
            expect(metadatoDe(ruta.nombre)).toBeDefined();
        }
    });
});

describe('PermissionsGuard sobre los cobros directos', () => {
    const guard = new PermissionsGuard(new Reflector());
    const proto = DirectChargesController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >;

    const esperarForbidden = (nombre: string, user: AuthUser) => {
        let capturado: unknown;
        try {
            guard.canActivate(contextoDe(proto[nombre], user));
        } catch (error) {
            capturado = error;
        }
        expect(capturado).toBeInstanceOf(AppError);
        expect((capturado as AppError).statusCode).toBe(403);
    };

    const CAJERO = usuario('cashier', permisosDe('cashier'));

    it('un cajero recibe 403 al intentar crear un cobro directo', () => {
        esperarForbidden('create', CAJERO);
    });

    it('un cajero recibe 403 al intentar crear un cobro en línea', () => {
        esperarForbidden('createOnline', CAJERO);
    });

    it('un cajero recibe 403 al intentar cancelar un cobro', () => {
        esperarForbidden('cancel', CAJERO);
    });

    it('un cajero recibe 403 incluso al listar o consultar', () => {
        esperarForbidden('list', CAJERO);
        esperarForbidden('get', CAJERO);
    });

    it('un doctor recibe 403 en los cinco endpoints', () => {
        const doctor = usuario('doctor', permisosDe('doctor'));
        for (const nombre of ['create', 'createOnline', 'list', 'get', 'cancel']) {
            esperarForbidden(nombre, doctor);
        }
    });

    it('el permiso de solo lectura no alcanza para cobrar ni cancelar', () => {
        const soloLectura = usuario('auditor', [{ area: AREA, level: 'read' }]);

        expect(guard.canActivate(contextoDe(proto.list, soloLectura))).toBe(true);
        expect(guard.canActivate(contextoDe(proto.get, soloLectura))).toBe(true);
        esperarForbidden('create', soloLectura);
        esperarForbidden('createOnline', soloLectura);
        esperarForbidden('cancel', soloLectura);
    });

    it('un manager pasa los cinco endpoints', () => {
        const manager = usuario('manager', permisosDe('manager'));
        for (const nombre of ['create', 'createOnline', 'list', 'get', 'cancel']) {
            expect(guard.canActivate(contextoDe(proto[nombre], manager))).toBe(true);
        }
    });

    it('sin sesión responde 401, no 403', () => {
        let capturado: unknown;
        try {
            guard.canActivate(contextoDe(proto.create, undefined));
        } catch (error) {
            capturado = error;
        }
        expect((capturado as AppError).statusCode).toBe(401);
    });
});
