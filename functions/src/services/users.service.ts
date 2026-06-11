import * as admin from 'firebase-admin';
import { UserProfile, UserRole } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import {
    countActiveAdmins,
    getUserProfile,
    listUserProfiles,
    updateUserProfile,
} from '../repositories/users.repository';

const assertNotSelf = (id: string, actorUid: string, message: string): void => {
    if (id === actorUid) {
        throw badRequest(message);
    }
};

const assertLastAdmin = async (id: string, existing: UserProfile): Promise<void> => {
    if (existing.role !== 'admin' || !existing.isActive) {
        return;
    }
    const remaining = await countActiveAdmins(id);
    if (remaining === 0) {
        throw badRequest('No se puede desactivar al último administrador activo');
    }
};

export const listUsers = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: UserProfile[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await listUserProfiles({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getUser = async (id: string): Promise<UserProfile> => {
    const user = await getUserProfile(id);
    if (!user) {
        throw notFound('Usuario');
    }
    return user;
};

export const updateUser = async (
    id: string,
    input: {
        displayName?: string;
        role?: UserRole;
        isActive?: boolean;
    },
    actorUid: string,
): Promise<UserProfile> => {
    const existing = await getUserProfile(id);
    if (!existing) {
        throw notFound('Usuario');
    }

    if (input.isActive === false) {
        assertNotSelf(id, actorUid, 'No puedes desactivar tu propia cuenta');
        await assertLastAdmin(id, existing);
    }

    if (input.role !== undefined && input.role !== 'admin' && id === actorUid) {
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

    if (input.role !== undefined && input.role !== existing.role) {
        await admin.auth().setCustomUserClaims(id, { role: input.role });
    }

    const profileUpdate: Partial<Pick<UserProfile, 'displayName' | 'role' | 'isActive'>> = {};
    if (input.displayName !== undefined) {
        profileUpdate.displayName = input.displayName;
    }
    if (input.role !== undefined) {
        profileUpdate.role = input.role;
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
    return updated;
};

export const deactivateUser = async (id: string, actorUid: string): Promise<UserProfile> =>
    updateUser(id, { isActive: false }, actorUid);
