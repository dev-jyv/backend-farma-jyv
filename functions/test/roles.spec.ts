import * as admin from 'firebase-admin';

import * as rolesRepo from '../src/repositories/roles.repository';
import {
    createUserProfile,
    getUserProfile,
    updateUserProfile,
} from '../src/repositories/users.repository';
import {
    applyRoleToUser,
    createRole,
    resolveActiveUserRole,
    rolePermissionsVersion,
    syncRoleUsersClaims,
    syncUserClaims,
    updateRole,
} from '../src/services/roles.service';
import { RolePermission } from '../src/types';

/**
 * `permissionsVersion` es el sello que hace segura la lectura del rol desde los
 * custom claims: el guard solo confía en un claim cuya versión coincide con la
 * del perfil. Todo lo que se fija aquí gira alrededor de mantener ese sello
 * honesto —subirlo cuando los permisos cambian y no subirlo cuando no— porque
 * un sello que no se mueve deja permisos retirados en circulación, y uno que se
 * mueve de más tira el ahorro de lecturas sin motivo.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const LECTURA: RolePermission[] = [{ area: 'sales', level: 'read' }];
const ESCRITURA: RolePermission[] = [
    { area: 'sales', level: 'write' },
    { area: 'inventory', level: 'write' },
];

const mockearClaims = () => {
    const setCustomUserClaims = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(admin, 'auth').mockReturnValue(
        { setCustomUserClaims } as unknown as admin.auth.Auth,
    );
    return setCustomUserClaims;
};

const crearRol = (permissions: RolePermission[], permissionsVersion?: number) =>
    rolesRepo.createRole({
        name: unique('Rol'),
        slug: unique('slug'),
        permissions,
        permissionsVersion,
        isSystem: false,
        isActive: true,
    });

const crearUsuarioDelRol = async (roleId: string, permissionsVersion = 1) => {
    const uid = unique('uid');
    await createUserProfile(uid, {
        email: `${uid}@farmajyv.test`,
        displayName: 'Usuaria de prueba',
        roleId,
        permissionsVersion,
        isActive: true,
    });
    return uid;
};

afterEach(() => {
    jest.restoreAllMocks();
});

describe('rolePermissionsVersion', () => {
    it('trata un rol sin el campo como versión 1', () => {
        // Los roles anteriores a la migración no lo traen; asumir 0 o NaN haría
        // que ningún claim coincidiera nunca.
        expect(rolePermissionsVersion({ permissionsVersion: undefined })).toBe(1);
        expect(rolePermissionsVersion({ permissionsVersion: 3 })).toBe(3);
    });
});

describe('syncUserClaims', () => {
    it('escribe el rol completo y su versión en los claims', async () => {
        const setCustomUserClaims = mockearClaims();
        const role = await crearRol(ESCRITURA, 4);

        await syncUserClaims('uid-1', role);

        // El guard reconstruye `req.authUser` con esto: si falta un campo, cae a
        // Firestore en cada request y la optimización deja de existir.
        expect(setCustomUserClaims).toHaveBeenCalledWith('uid-1', {
            roleId: role.id,
            roleSlug: role.slug,
            roleName: role.name,
            permissions: ESCRITURA,
            permissionsVersion: 4,
        });
    });
});

describe('applyRoleToUser', () => {
    it('deja claims y perfil sellados con la misma versión', async () => {
        const setCustomUserClaims = mockearClaims();
        const role = await crearRol(LECTURA, 2);
        const uid = await crearUsuarioDelRol(role.id, 1);

        await applyRoleToUser(uid, role);

        const perfil = await getUserProfile(uid);
        expect(perfil).toMatchObject({ roleId: role.id, permissionsVersion: 2 });
        expect(setCustomUserClaims).toHaveBeenCalledWith(
            uid,
            expect.objectContaining({ roleId: role.id, permissionsVersion: 2 }),
        );
    });
});

describe('updateRole - versionado de permisos', () => {
    it('sube la versión y resincroniza claims cuando los permisos cambian', async () => {
        const setCustomUserClaims = mockearClaims();
        const role = await crearRol(ESCRITURA, 1);
        const uid = await crearUsuarioDelRol(role.id, 1);

        const actualizado = await updateRole(role.id, { permissions: LECTURA });

        expect(rolePermissionsVersion(actualizado!)).toBe(2);
        expect(setCustomUserClaims).toHaveBeenCalledWith(
            uid,
            expect.objectContaining({ permissions: LECTURA, permissionsVersion: 2 }),
        );
        // El perfil tiene que quedar sellado con la versión nueva; si se queda en
        // la 1, el guard descarta para siempre unos claims que sí son correctos.
        expect(await getUserProfile(uid)).toMatchObject({ permissionsVersion: 2 });
    });

    it('no toca la versión al renombrar el rol', async () => {
        const setCustomUserClaims = mockearClaims();
        const role = await crearRol(LECTURA, 1);

        const actualizado = await updateRole(role.id, { name: 'Nombre nuevo' });

        expect(actualizado!.name).toBe('Nombre nuevo');
        expect(rolePermissionsVersion(actualizado!)).toBe(1);
        // Reemitir claims por un cambio cosmético invalidaría todos los tokens
        // vigentes sin que ningún permiso haya cambiado.
        expect(setCustomUserClaims).not.toHaveBeenCalled();
    });

    it('no sube la versión si los permisos llegan reordenados pero son los mismos', async () => {
        const setCustomUserClaims = mockearClaims();
        const role = await crearRol(ESCRITURA, 1);

        const actualizado = await updateRole(role.id, {
            permissions: [...ESCRITURA].reverse(),
        });

        expect(rolePermissionsVersion(actualizado!)).toBe(1);
        expect(setCustomUserClaims).not.toHaveBeenCalled();
    });
});

describe('updateRole - protecciones', () => {
    it('rechaza desactivar un rol con usuarios activos asignados', async () => {
        const role = await crearRol(LECTURA);
        await crearUsuarioDelRol(role.id);

        await expect(updateRole(role.id, { isActive: false })).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('rechaza desactivar un rol del sistema', async () => {
        const role = await rolesRepo.createRole({
            name: unique('Sistema'),
            slug: unique('sistema'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: true,
            isActive: true,
        });

        await expect(updateRole(role.id, { isActive: false })).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('rechaza dejar un rol sin ningún permiso', async () => {
        const role = await crearRol(LECTURA);

        await expect(updateRole(role.id, { permissions: [] })).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('rechaza un rol inexistente con 404', async () => {
        await expect(updateRole('no-existe', { name: 'x' })).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});

describe('createRole', () => {
    it('nace en la versión 1 y normaliza el slug', async () => {
        const slug = unique('MiSlug');
        const creado = await createRole({
            name: '  Rol con espacios  ',
            slug: `  ${slug.toUpperCase()}  `,
            permissions: LECTURA,
        });

        expect(creado.name).toBe('Rol con espacios');
        expect(creado.slug).toBe(slug.toLowerCase());
        expect(rolePermissionsVersion(creado)).toBe(1);
    });

    it('rechaza un slug ya usado por otro rol activo', async () => {
        const slug = unique('duplicado');
        await createRole({ name: 'Primero', slug, permissions: LECTURA });

        await expect(
            createRole({ name: 'Segundo', slug, permissions: LECTURA }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rechaza un rol sin permisos', async () => {
        await expect(
            createRole({ name: 'Vacío', slug: unique('vacio'), permissions: [] }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });
});

describe('syncRoleUsersClaims', () => {
    it('resella a todos los usuarios activos del rol', async () => {
        const setCustomUserClaims = mockearClaims();
        const role = await crearRol(ESCRITURA, 7);
        const uids = [
            await crearUsuarioDelRol(role.id, 1),
            await crearUsuarioDelRol(role.id, 1),
        ];

        await expect(syncRoleUsersClaims(role.id)).resolves.toBe(2);

        for (const uid of uids) {
            expect(setCustomUserClaims).toHaveBeenCalledWith(
                uid,
                expect.objectContaining({ permissionsVersion: 7 }),
            );
            expect(await getUserProfile(uid)).toMatchObject({ permissionsVersion: 7 });
        }
    });

    it('no hace nada con un rol inexistente', async () => {
        const setCustomUserClaims = mockearClaims();
        await expect(syncRoleUsersClaims('no-existe')).resolves.toBe(0);
        expect(setCustomUserClaims).not.toHaveBeenCalled();
    });
});

describe('resolveActiveUserRole', () => {
    it('resuelve por roleId', async () => {
        const role = await crearRol(ESCRITURA);
        await expect(resolveActiveUserRole({ roleId: role.id })).resolves.toMatchObject({
            id: role.id,
        });
    });

    it('rechaza un rol desactivado en vez de devolverlo', async () => {
        const role = await rolesRepo.createRole({
            name: unique('Inactivo'),
            slug: unique('inactivo'),
            permissions: ESCRITURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: false,
        });

        await expect(resolveActiveUserRole({ roleId: role.id })).rejects.toMatchObject({
            statusCode: 401,
        });
    });

    it('rechaza cuando no hay ni roleId ni slug utilizable', async () => {
        await expect(resolveActiveUserRole({})).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe('caché de perfiles', () => {
    it('una escritura de perfil invalida la caché en vez de servir el valor viejo', async () => {
        const role = await crearRol(LECTURA);
        const uid = await crearUsuarioDelRol(role.id);

        // Deja el perfil cacheado y luego lo cambia por debajo.
        expect(await getUserProfile(uid)).toMatchObject({ displayName: 'Usuaria de prueba' });
        await updateUserProfile(uid, { displayName: 'Nombre cambiado' });

        // Sin la invalidación, el guard seguiría autenticando con datos viejos
        // durante todo el TTL —incluido un `isActive` ya revocado.
        expect(await getUserProfile(uid)).toMatchObject({ displayName: 'Nombre cambiado' });
    });
});
