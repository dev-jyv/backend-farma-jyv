import * as admin from 'firebase-admin';
import { AuthUser, UserRole } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import {
    createUserProfile,
    getUserProfile,
    isValidRole,
    updateUserProfile,
} from '../repositories/users.repository';

export const getAuthenticatedUser = async (uid: string): Promise<AuthUser> => {
    const profile = await getUserProfile(uid);
    if (!profile || !profile.isActive) {
        throw notFound('Usuario');
    }

    return {
        uid: profile.id,
        email: profile.email,
        role: profile.role,
        displayName: profile.displayName,
    };
};

export const registerStaff = async (input: {
    email: string;
    password: string;
    displayName: string;
    role: UserRole;
}): Promise<AuthUser> => {
    if (!isValidRole(input.role)) {
        throw badRequest('Rol inválido');
    }

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

    await admin.auth().setCustomUserClaims(userRecord.uid, { role: input.role });

    await createUserProfile(userRecord.uid, {
        email: input.email,
        displayName: input.displayName,
        role: input.role,
        isActive: true,
    });

    return {
        uid: userRecord.uid,
        email: input.email,
        role: input.role,
        displayName: input.displayName,
    };
};

export const syncUserRole = async (
    uid: string,
    role: UserRole,
): Promise<void> => {
    await admin.auth().setCustomUserClaims(uid, { role });
    await updateUserProfile(uid, { role });
};
