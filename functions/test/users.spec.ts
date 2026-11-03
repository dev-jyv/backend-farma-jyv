import * as admin from 'firebase-admin';

import * as rolesRepo from '../src/repositories/roles.repository';
import {
    createUserProfile,
    getUserProfile,
    listUserProfiles,
    updateUserProfile,
} from '../src/repositories/users.repository';
import { updateUser, deactivateUser, getUser, listUsers } from '../src/services/users.service';
import { registerStaff } from '../src/services/auth.service';
import { registerStaffSchema, updateUserSchema } from '../src/schemas';
import { RolePermission } from '../src/types';
import { db } from '../src/utils/firestore';

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

describe('monthlyReportEmail (SPEC 45)', () => {
    const rolContador = () => rolesRepo.createRole({
        name: unique('Contador'),
        slug: unique('accountant'),
        permissions: [{ area: 'reportDownloads', level: 'read' }],
        permissionsVersion: 1,
        isSystem: false,
        isActive: true,
    });

    const auditoriaDe = async (uid: string) => {
        const snapshot = await db()
            .collection('auditLogs')
            .where('entityId', '==', uid)
            .where('action', '==', 'user.updated')
            .get();
        return snapshot.docs.map((doc) => doc.data());
    };

    it('el alta lo guarda y lo devuelve; sin el campo no se escribe', async () => {
        const createUser = jest.fn()
            .mockResolvedValueOnce({ uid: unique('uid-con') })
            .mockResolvedValueOnce({ uid: unique('uid-sin') });
        jest.spyOn(admin, 'auth').mockReturnValue({
            createUser,
            setCustomUserClaims: jest.fn().mockResolvedValue(undefined),
        } as unknown as admin.auth.Auth);
        const role = await rolContador();

        const con = await registerStaff({
            email: `${unique('c')}@farmajyv.test`,
            password: 'secreta123',
            displayName: 'Contadora',
            roleId: role.id,
            monthlyReportEmail: true,
        });
        const sin = await registerStaff({
            email: `${unique('s')}@farmajyv.test`,
            password: 'secreta123',
            displayName: 'Sin correo',
            roleId: role.id,
        });

        expect(con.monthlyReportEmail).toBe(true);
        expect(sin).not.toHaveProperty('monthlyReportEmail');
        expect((await getUser(con.uid)).monthlyReportEmail).toBe(true);
        expect((await getUser(sin.uid)).monthlyReportEmail).toBeUndefined();
        // Los dos aparecen en el listado con el campo tal como quedó guardado.
        const { items } = await listUsers({ roleId: role.id });
        const porUid = new Map(items.map((user) => [user.id, user.monthlyReportEmail]));
        expect(porUid.get(con.uid)).toBe(true);
        expect(porUid.get(sin.uid)).toBeUndefined();
    });

    it('PATCH lo activa y lo desactiva, y cada cambio se audita', async () => {
        mockearAuth();
        const role = await rolContador();
        const uid = await crearUsuario(role.id);
        const actor = unique('actor');

        const activado = await updateUser(uid, { monthlyReportEmail: true }, actor, 'admin');
        expect(activado.monthlyReportEmail).toBe(true);
        await updateUser(uid, { monthlyReportEmail: false }, actor, 'admin');
        expect((await getUserProfile(uid))?.monthlyReportEmail).toBe(false);

        const logs = await auditoriaDe(uid);
        expect(logs.map((log) => log.changes.monthlyReportEmail).sort(
            (a, b) => Number(a.before) - Number(b.before),
        )).toEqual([
            { before: false, after: true },
            { before: true, after: false },
        ]);
        expect(logs.every((log) => log.userId === actor && log.roleSlug === 'admin')).toBe(true);
    });

    it('un PATCH que no cambia el valor no deja bitácora', async () => {
        mockearAuth();
        const role = await rolContador();
        const uid = await crearUsuario(role.id);

        // Sin el campo equivale a `false`: mandar `false` no es un cambio.
        await updateUser(uid, { monthlyReportEmail: false }, unique('actor'));
        await updateUser(uid, { displayName: 'Otro nombre' }, unique('actor'));

        expect(await auditoriaDe(uid)).toEqual([]);
    });

    it('el schema lo acepta en alta y edición, y solo como booleano', () => {
        expect(updateUserSchema.parse({ monthlyReportEmail: true })).toEqual({
            monthlyReportEmail: true,
        });
        expect(updateUserSchema.safeParse({ monthlyReportEmail: 'sí' }).success).toBe(false);
        expect(registerStaffSchema.parse({
            email: 'a@b.mx',
            password: 'secreta123',
            displayName: 'Ana',
            roleId: 'r1',
            monthlyReportEmail: false,
        }).monthlyReportEmail).toBe(false);
    });
});
