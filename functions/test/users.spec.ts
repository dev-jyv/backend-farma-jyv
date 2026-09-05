import * as admin from 'firebase-admin';

import * as rolesRepo from '../src/repositories/roles.repository';
import {
    createUserProfile,
    getUserProfile,
    listUserProfiles,
    updateUserProfile,
} from '../src/repositories/users.repository';
import { updateUser, deactivateUser } from '../src/services/users.service';
import { RolePermission } from '../src/types';

/**
 * `updateUser` concentra las protecciones de acceso del panel: nadie puede
 * dejarse fuera a sí mismo ni dejar la instalación sin administradores. Son
 * reglas que solo se descubren rotas cuando ya no queda nadie que pueda
 * entrar a arreglarlas, así que cada una tiene su caso.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const LECTURA: RolePermission[] = [{ area: 'sales', level: 'read' }];

const mockearAuth = () => {
    const updateUserRecord = jest.fn().mockResolvedValue(undefined);
    const setCustomUserClaims = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(admin, 'auth').mockReturnValue({
        updateUser: updateUserRecord,
        setCustomUserClaims,
    } as unknown as admin.auth.Auth);
    return { updateUserRecord, setCustomUserClaims };
};

/**
 * El rol de administrador se identifica por el slug `admin`, que es único en la
 * instalación: se reutiliza el que hayan dejado otras suites en el emulador.
 */
const rolAdmin = async () => {
    const existente = await rolesRepo.getRoleBySlug('admin');
    if (existente) {
        return existente;
    }
    return rolesRepo.createRole({
        name: 'Administrador',
        slug: 'admin',
        permissions: [{ area: 'users', level: 'write' }],
        permissionsVersion: 1,
        isSystem: true,
        isActive: true,
    });
};

const crearUsuario = async (roleId: string, isActive = true, permissionsVersion = 1) => {
    const uid = unique('uid');
    await createUserProfile(uid, {
        email: `${uid}@farmajyv.test`,
        displayName: 'Usuaria de prueba',
        roleId,
        permissionsVersion,
        isActive,
    });
    return uid;
};

/**
 * Deja exactamente un administrador activo: los que hayan quedado de otras
 * suites se desactivan directamente en el repositorio para no pasar por las
 * validaciones que precisamente se están probando.
 */
const dejarUnSoloAdmin = async () => {
    const role = await rolAdmin();
    const { items } = await listUserProfiles({
        roleId: role.id,
        activeOnly: true,
        page: 1,
        limit: 1000,
    });
    for (const user of items) {
        await updateUserProfile(user.id, { isActive: false });
    }
    const uid = await crearUsuario(role.id);
    return { role, uid };
};

afterEach(() => {
    jest.restoreAllMocks();
});

describe('updateUser - protecciones de acceso', () => {
    it('impide que alguien desactive su propia cuenta', async () => {
        mockearAuth();
        const role = await rolesRepo.createRole({
            name: unique('Rol'),
            slug: unique('slug'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });
        const uid = await crearUsuario(role.id);

        await expect(
            updateUser(uid, { isActive: false }, uid),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(await getUserProfile(uid)).toMatchObject({ isActive: true });
    });

    it('impide desactivar al último administrador activo', async () => {
        mockearAuth();
        const { uid } = await dejarUnSoloAdmin();
        const otroActor = unique('actor');

        await expect(
            updateUser(uid, { isActive: false }, otroActor),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(await getUserProfile(uid)).toMatchObject({ isActive: true });
    });

    it('permite desactivar a un administrador mientras quede otro', async () => {
        mockearAuth();
        const { role, uid } = await dejarUnSoloAdmin();
        await crearUsuario(role.id);

        await expect(
            updateUser(uid, { isActive: false }, unique('actor')),
        ).resolves.toMatchObject({ isActive: false });
    });

    it('impide que un administrador se quite a sí mismo el rol de administrador', async () => {
        mockearAuth();
        const { uid } = await dejarUnSoloAdmin();
        const otroRol = await rolesRepo.createRole({
            name: unique('Cajero'),
            slug: unique('cajero'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });

        await expect(
            updateUser(uid, { roleId: otroRol.id }, uid),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('impide degradar al último administrador aunque lo haga otra persona', async () => {
        mockearAuth();
        const { uid } = await dejarUnSoloAdmin();
        const otroRol = await rolesRepo.createRole({
            name: unique('Cajero'),
            slug: unique('cajero'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });

        await expect(
            updateUser(uid, { roleId: otroRol.id }, unique('actor')),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('devuelve 404 para un usuario inexistente', async () => {
        mockearAuth();
        await expect(
            updateUser(unique('fantasma'), { displayName: 'x' }, unique('actor')),
        ).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('updateUser - cambio de rol', () => {
    it('sella permissionsVersion junto al roleId', async () => {
        const { setCustomUserClaims } = mockearAuth();
        const origen = await rolesRepo.createRole({
            name: unique('Origen'),
            slug: unique('origen'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });
        const destino = await rolesRepo.createRole({
            name: unique('Destino'),
            slug: unique('destino'),
            permissions: LECTURA,
            permissionsVersion: 5,
            isSystem: false,
            isActive: true,
        });
        const uid = await crearUsuario(origen.id);

        await updateUser(uid, { roleId: destino.id }, unique('actor'));

        // Si el perfil apunta al rol nuevo conservando la versión vieja, el
        // guard descarta los claims recién emitidos y vuelve a pagar una lectura
        // de `roles` en cada request.
        expect(await getUserProfile(uid)).toMatchObject({
            roleId: destino.id,
            permissionsVersion: 5,
        });
        expect(setCustomUserClaims).toHaveBeenCalledWith(
            uid,
            expect.objectContaining({ roleId: destino.id, permissionsVersion: 5 }),
        );
    });

    it('rechaza asignar un rol inactivo', async () => {
        mockearAuth();
        const activo = await rolesRepo.createRole({
            name: unique('Activo'),
            slug: unique('activo'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });
        const inactivo = await rolesRepo.createRole({
            name: unique('Inactivo'),
            slug: unique('inactivo'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: false,
        });
        const uid = await crearUsuario(activo.id);

        await expect(
            updateUser(uid, { roleId: inactivo.id }, unique('actor')),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('renombrar no reemite claims', async () => {
        const { setCustomUserClaims } = mockearAuth();
        const role = await rolesRepo.createRole({
            name: unique('Rol'),
            slug: unique('slug'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });
        const uid = await crearUsuario(role.id);

        await updateUser(uid, { displayName: 'Nombre nuevo' }, unique('actor'));

        expect(await getUserProfile(uid)).toMatchObject({ displayName: 'Nombre nuevo' });
        expect(setCustomUserClaims).not.toHaveBeenCalled();
    });
});

describe('deactivateUser', () => {
    it('desactiva también la cuenta en Firebase Auth', async () => {
        const { updateUserRecord } = mockearAuth();
        const role = await rolesRepo.createRole({
            name: unique('Rol'),
            slug: unique('slug'),
            permissions: LECTURA,
            permissionsVersion: 1,
            isSystem: false,
            isActive: true,
        });
        const uid = await crearUsuario(role.id);

        await deactivateUser(uid, unique('actor'));

        // El perfil por sí solo no impide autenticarse: sin `disabled` el
        // usuario sigue obteniendo tokens válidos.
        expect(updateUserRecord).toHaveBeenCalledWith(uid, { disabled: true });
        expect(await getUserProfile(uid)).toMatchObject({ isActive: false });
    });
});
