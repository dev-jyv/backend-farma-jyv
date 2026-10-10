import * as admin from 'firebase-admin';
import { AuthUser } from '../types';
import { badRequest, conflict } from '../utils/errors';
import { createUserProfile } from '../repositories/users.repository';
import { getActiveRoleById, rolePermissionsVersion, syncUserClaims } from './roles.service';

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

    try {
        await syncUserClaims(userRecord.uid, role);
        await createUserProfile(userRecord.uid, {
            email: input.email,
            displayName: input.displayName,
            roleId: role.id,
            permissionsVersion: rolePermissionsVersion(role),
            isActive: true,
        });
    } catch (error) {
        try {
            await admin.auth().deleteUser(userRecord.uid);
        } catch {
            // Best-effort cleanup; surface the original failure below.
        }
        throw error;
    }

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
