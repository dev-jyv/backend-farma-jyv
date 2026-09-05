import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as admin from 'firebase-admin';

import { AuthGuard } from '../src/modules/identity/guards/auth.guard';
import { IS_PUBLIC_KEY } from '../src/modules/identity/decorators/public.decorator';
import * as rolesRepo from '../src/repositories/roles.repository';
import {
    createUserProfile,
    invalidateUserProfileCache,
    updateUserProfile,
} from '../src/repositories/users.repository';
import { RolePermission } from '../src/types';

/**
 * El guard resuelve el rol desde los custom claims para no leer `roles` en cada
 * request. Ese atajo es correcto solo mientras el sello del claim coincida con
 * el del perfil: si no, tiene que caer a Firestore.
 *
 * Lo que se fija aquí es el lado peligroso de esa optimización. Un claim viejo
 * aceptado de más es un permiso que ya se retiró y sigue vigente hasta que
 * expire el token —hasta una hora—, así que cada caso comprueba tanto los
 * permisos entregados como si se pagó o no la lectura de `roles`.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const PERMISOS_AMPLIOS: RolePermission[] = [
    { area: 'inventory', level: 'write' },
    { area: 'sales', level: 'write' },
];
const PERMISOS_REDUCIDOS: RolePermission[] = [{ area: 'sales', level: 'read' }];

/** `auth_time` de hoy: la sesión caduca a las 24:00 hora de Ciudad de México. */
const authTimeReciente = () => Math.floor(Date.now() / 1000);

type Claims = Record<string, unknown>;

const mockearToken = (uid: string, claims: Claims, authTime = authTimeReciente()) => {
    jest.spyOn(admin, 'auth').mockReturnValue({
        verifyIdToken: jest.fn().mockResolvedValue({
            uid,
            auth_time: authTime,
            ...claims,
        }),
    } as unknown as admin.auth.Auth);
};

const contexto = (): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
} as unknown as ExecutionContext);

let request: { headers: { authorization?: string }; authUser?: unknown };

const construirGuard = (esPublica = false) => {
    const reflector = {
        getAllAndOverride: jest.fn((key: string) =>
            key === IS_PUBLIC_KEY ? esPublica : undefined,
        ),
    } as unknown as Reflector;
    return new AuthGuard(reflector);
};

const ejecutar = async (guard: AuthGuard) => guard.canActivate(contexto());

/** Rol + usuario cuyo perfil apunta a ese rol con el sello vigente. */
const sembrarUsuario = async (permissions: RolePermission[], permissionsVersion = 1) => {
    const role = await rolesRepo.createRole({
        name: unique('Rol'),
        slug: unique('slug'),
        permissions,
        permissionsVersion,
        isSystem: false,
        isActive: true,
    });

    const uid = unique('uid');
    await createUserProfile(uid, {
        email: `${uid}@farmajyv.test`,
        displayName: 'Usuaria de prueba',
        roleId: role.id,
        permissionsVersion,
        isActive: true,
    });

    return { role, uid };
};

const claimsDe = (
    role: { id: string; name: string; slug: string },
    permissions: RolePermission[],
    permissionsVersion: number,
): Claims => ({
    roleId: role.id,
    roleSlug: role.slug,
    roleName: role.name,
    permissions,
    permissionsVersion,
});

beforeEach(() => {
    request = { headers: {} };
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('AuthGuard - rol desde claims', () => {
    it('acepta los claims sellados y no lee la colección de roles', async () => {
        const { role, uid } = await sembrarUsuario(PERMISOS_AMPLIOS);
        mockearToken(uid, claimsDe(role, PERMISOS_AMPLIOS, 1));
        request.headers.authorization = 'Bearer token-valido';

        const leerRol = jest.spyOn(rolesRepo, 'getRoleById');

        await expect(ejecutar(construirGuard())).resolves.toBe(true);

        expect(request.authUser).toMatchObject({
            uid,
            roleId: role.id,
            role: { id: role.id, name: role.name, slug: role.slug },
            permissions: PERMISOS_AMPLIOS,
        });
        // El ahorro entero de la optimización depende de esta línea.
        expect(leerRol).not.toHaveBeenCalled();
    });

    it('descarta los claims cuando el rol cambió de permisos y aplica los nuevos', async () => {
        // El rol ya va por la versión 2 (permisos recortados) y el perfil está
        // sellado con esa versión; el token del usuario quedó en la 1.
        const { role, uid } = await sembrarUsuario(PERMISOS_REDUCIDOS, 2);
        mockearToken(uid, claimsDe(role, PERMISOS_AMPLIOS, 1));
        request.headers.authorization = 'Bearer token-viejo';

        await expect(ejecutar(construirGuard())).resolves.toBe(true);

        expect(request.authUser).toMatchObject({ permissions: PERMISOS_REDUCIDOS });
    });

    it('descarta los claims cuando apuntan a un rol distinto al del perfil', async () => {
        const { role, uid } = await sembrarUsuario(PERMISOS_REDUCIDOS);
        const otroRol = await rolesRepo.createRole({
            name: unique('Otro'),
            slug: unique('otro'),
            permissions: PERMISOS_AMPLIOS,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });
        mockearToken(uid, claimsDe(otroRol, PERMISOS_AMPLIOS, 1));
        request.headers.authorization = 'Bearer token-de-rol-viejo';

        await expect(ejecutar(construirGuard())).resolves.toBe(true);

        expect(request.authUser).toMatchObject({
            roleId: role.id,
            permissions: PERMISOS_REDUCIDOS,
        });
    });

    it('cae a Firestore cuando el token no trae claims (usuario sin migrar)', async () => {
        const { role, uid } = await sembrarUsuario(PERMISOS_AMPLIOS);
        mockearToken(uid, {});
        request.headers.authorization = 'Bearer token-sin-claims';

        await expect(ejecutar(construirGuard())).resolves.toBe(true);

        expect(request.authUser).toMatchObject({
            roleId: role.id,
            permissions: PERMISOS_AMPLIOS,
        });
    });
});

describe('AuthGuard - rechazo de sesiones', () => {
    it('rechaza cuando no hay encabezado Bearer', async () => {
        await expect(ejecutar(construirGuard())).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rechaza un encabezado que no es Bearer', async () => {
        request.headers.authorization = 'Basic dXN1YXJpbzpjbGF2ZQ==';
        await expect(ejecutar(construirGuard())).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rechaza al usuario desactivado aunque su token siga siendo válido', async () => {
        const { role, uid } = await sembrarUsuario(PERMISOS_AMPLIOS);
        await updateUserProfile(uid, { isActive: false });
        mockearToken(uid, claimsDe(role, PERMISOS_AMPLIOS, 1));
        request.headers.authorization = 'Bearer token-valido';

        await expect(ejecutar(construirGuard())).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rechaza a un uid sin perfil', async () => {
        const uid = unique('fantasma');
        invalidateUserProfileCache(uid);
        mockearToken(uid, {});
        request.headers.authorization = 'Bearer token-sin-perfil';

        await expect(ejecutar(construirGuard())).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rechaza una sesión iniciada antes del corte de las 24:00', async () => {
        const { role, uid } = await sembrarUsuario(PERMISOS_AMPLIOS);
        const haceDosDias = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
        mockearToken(uid, claimsDe(role, PERMISOS_AMPLIOS, 1), haceDosDias);
        request.headers.authorization = 'Bearer token-de-anteayer';

        await expect(ejecutar(construirGuard())).rejects.toMatchObject({ statusCode: 401 });
    });

    it('convierte un fallo de verificación del token en 401, no en 500', async () => {
        jest.spyOn(admin, 'auth').mockReturnValue({
            verifyIdToken: jest.fn().mockRejectedValue(new Error('token corrupto')),
        } as unknown as admin.auth.Auth);
        request.headers.authorization = 'Bearer basura';

        await expect(ejecutar(construirGuard())).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe('AuthGuard - rutas públicas', () => {
    it('deja pasar sin token ni lecturas', async () => {
        const verificar = jest.fn();
        jest.spyOn(admin, 'auth').mockReturnValue(
            { verifyIdToken: verificar } as unknown as admin.auth.Auth,
        );

        await expect(ejecutar(construirGuard(true))).resolves.toBe(true);

        expect(verificar).not.toHaveBeenCalled();
        expect(request.authUser).toBeUndefined();
    });
});
