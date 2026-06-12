import * as admin from 'firebase-admin';
import { RoleSummary, UserProfile, UserWithRole } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import {
    countActiveAdmins,
    getUserProfile,
    listUserProfiles,
    updateUserProfile,
} from '../repositories/users.repository';
import * as rolesRepo from '../repositories/roles.repository';
import { getActiveRoleById, getAdminRoleId, syncUserClaims } from './roles.service';

const toRoleSummary = (role: { id: string; name: string; slug: string }): RoleSummary => ({
    id: role.id,
    name: role.name,
    slug: role.slug,
});

const buildRoleMap = (roles: Array<{ id: string; name: string; slug: string }>) =>
    new Map(roles.map((role) => [role.id, toRoleSummary(role)]));

const enrichUser = (user: UserProfile, roleMap: Map<string, RoleSummary>): UserWithRole => ({
    ...user,
    role: roleMap.get(user.roleId) ?? {
        id: user.roleId,
        name: 'Rol no encontrado',
        slug: '',
    },
});

const enrichUsers = async (users: UserProfile[]): Promise<UserWithRole[]> => {
    const roles = await rolesRepo.getAllRoles();
    const roleMap = buildRoleMap(roles);
    return users.map((user) => enrichUser(user, roleMap));
};

const enrichSingleUser = async (user: UserProfile): Promise<UserWithRole> => {
    const role = await rolesRepo.getRoleById(user.roleId);
    return {
        ...user,
        role: role
            ? toRoleSummary(role)
            : { id: user.roleId, name: 'Rol no encontrado', slug: '' },
    };
};

const assertNotSelf = (id: string, actorUid: string, message: string): void => {
    if (id === actorUid) {
        throw badRequest(message);
    }
};

const assertLastAdmin = async (id: string, existing: UserProfile): Promise<void> => {
    const adminRoleId = await getAdminRoleId();
    if (!adminRoleId || existing.roleId !== adminRoleId || !existing.isActive) {
        return;
    }
    const remaining = await countActiveAdmins(id);
    if (remaining === 0) {
        throw badRequest('No se puede desactivar al último administrador activo');
    }
};

export const listUsers = async (filters: {
    activeOnly?: boolean;
    roleId?: string;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: UserWithRole[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await listUserProfiles({ ...filters, page, limit });
    return {
        items: await enrichUsers(items),
        meta: buildListMeta(page, limit, total),
    };
};

export const getUser = async (id: string): Promise<UserWithRole> => {
    const user = await getUserProfile(id);
    if (!user) {
        throw notFound('Usuario');
    }
    return enrichSingleUser(user);
};

export const updateUser = async (
    id: string,
    input: {
        displayName?: string;
        roleId?: string;
        isActive?: boolean;
    },
    actorUid: string,
): Promise<UserWithRole> => {
    const existing = await getUserProfile(id);
    if (!existing) {
        throw notFound('Usuario');
    }

    if (input.isActive === false) {
        assertNotSelf(id, actorUid, 'No puedes desactivar tu propia cuenta');
        await assertLastAdmin(id, existing);
    }

    const adminRoleId = await getAdminRoleId();
    if (
        input.roleId !== undefined &&
        adminRoleId &&
        input.roleId !== adminRoleId &&
        id === actorUid &&
        existing.roleId === adminRoleId
    ) {
        throw badRequest('No puedes quitarte tu propio rol de administrador');
    }

    const authUpdate: admin.auth.UpdateRequest = {};

    if (input.displayName !== undefined) {
        authUpdate.displayName = input.displayName;
    }

    if (input.isActive !== undefined) {
        authUpdate.disabled = !input.isActive;
    }

    if (Object.keys(authUpdate).length > 0) {
        await admin.auth().updateUser(id, authUpdate);
    }

    let roleToSync = existing.roleId;
    if (input.roleId !== undefined && input.roleId !== existing.roleId) {
        const role = await getActiveRoleById(input.roleId);
        roleToSync = role.id;
        await syncUserClaims(id, role.id, role.slug, role.permissions);
    }

    const profileUpdate: Partial<Pick<UserProfile, 'displayName' | 'roleId' | 'isActive'>> = {};
    if (input.displayName !== undefined) {
        profileUpdate.displayName = input.displayName;
    }
    if (input.roleId !== undefined) {
        profileUpdate.roleId = roleToSync;
    }
    if (input.isActive !== undefined) {
        profileUpdate.isActive = input.isActive;
    }

    if (Object.keys(profileUpdate).length > 0) {
        await updateUserProfile(id, profileUpdate);
    }

    const updated = await getUserProfile(id);
    if (!updated) {
        throw notFound('Usuario');
    }
    return enrichSingleUser(updated);
};

export const deactivateUser = async (id: string, actorUid: string): Promise<UserWithRole> =>
    updateUser(id, { isActive: false }, actorUid);
