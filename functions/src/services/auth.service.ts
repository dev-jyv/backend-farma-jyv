import * as admin from 'firebase-admin';
import { AuthUser, UserProfile } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import {
    createUserProfile,
    getUserProfile,
    updateUserProfile,
} from '../repositories/users.repository';
import { getActiveRoleById, resolveActiveUserRole, syncUserClaims } from './roles.service';

type UserProfileWithLegacyRole = UserProfile & { role?: string };

export const getAuthenticatedUser = async (uid: string): Promise<AuthUser> => {
    const profile = await getUserProfile(uid);
    if (!profile || !profile.isActive) {
        throw notFound('Usuario');
    }

    const legacyProfile = profile as UserProfileWithLegacyRole;
    const role = await resolveActiveUserRole({
        roleId: legacyProfile.roleId,
        legacyRole: legacyProfile.role,
    });

    return {
        uid: profile.id,
        email: profile.email,
        roleId: role.id,
        role: {
            id: role.id,
            name: role.name,
            slug: role.slug,
        },
        permissions: role.permissions,
        displayName: profile.displayName,
    };
};

export const registerStaff = async (input: {
    email: string;
    password: string;
    displayName: string;
    roleId: string;
}): Promise<AuthUser> => {
    const role = await getActiveRoleById(input.roleId);

    let userRecord: admin.auth.UserRecord;

    try {
        userRecord = await admin.auth().createUser({
            email: input.email,
            password: input.password,
            displayName: input.displayName,
        });
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'auth/email-already-exists') {
            throw conflict('El correo ya está registrado');
        }
        throw badRequest('No se pudo crear el usuario');
    }

    await syncUserClaims(userRecord.uid, role.id, role.slug, role.permissions);

    await createUserProfile(userRecord.uid, {
        email: input.email,
        displayName: input.displayName,
        roleId: role.id,
        isActive: true,
    });

    return {
        uid: userRecord.uid,
        email: input.email,
        roleId: role.id,
        role: {
            id: role.id,
            name: role.name,
            slug: role.slug,
        },
        permissions: role.permissions,
        displayName: input.displayName,
    };
};

export const syncUserRole = async (
    uid: string,
    roleId: string,
): Promise<void> => {
    const role = await getActiveRoleById(roleId);
    await syncUserClaims(uid, role.id, role.slug, role.permissions);
    await updateUserProfile(uid, { roleId: role.id });
};
