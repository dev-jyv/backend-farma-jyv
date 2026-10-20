import { UserProfile } from '../types';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now } from '../utils/firestore';
import { MemoryCache } from '../utils/memory-cache';
import { applyNamePrefix, normalizeSearchName } from '../utils/search-name';

const collection = () => db().collection('users');

/**
 * El guard de autenticación lee el perfil en cada request, así que sin caché
 * cada llamada al API cuesta una lectura de Firestore solo por autenticar.
 * El TTL es corto para que desactivar o reasignar a un usuario surta efecto
 * pronto aunque la escritura ocurra en otra instancia de la function.
 */
const PROFILE_CACHE_TTL_MS = 60_000;
const profileCache = new MemoryCache<UserProfile | null>(PROFILE_CACHE_TTL_MS);

export const invalidateUserProfileCache = (uid: string): void => {
    profileCache.invalidate(uid);
};

const readUserProfile = async (uid: string): Promise<UserProfile | null> => {
    const doc = await collection().doc(uid).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as UserProfile;
};

export const getUserProfile = async (uid: string): Promise<UserProfile | null> => {
    const cached = profileCache.get(uid);
    if (cached !== undefined) {
        return cached;
    }
    const profile = await readUserProfile(uid);
    profileCache.set(uid, profile);
    return profile;
};

export const createUserProfile = async (
    uid: string,
    data: Omit<UserProfile, 'id' | 'createdAt'>,
): Promise<UserProfile> => {
    const timestamp = now();
    const profile: Omit<UserProfile, 'id'> = {
        ...data,
        searchName: normalizeSearchName(data.displayName),
        createdAt: timestamp,
    };
    await collection().doc(uid).set(profile);
    const created = { id: uid, ...profile };
    profileCache.set(uid, created);
    return created;
};

export const updateUserProfile = async (
    uid: string,
    data: Partial<
        Pick<UserProfile, 'displayName' | 'roleId' | 'permissionsVersion' | 'isActive'>
    >,
): Promise<void> => {
    await collection()
        .doc(uid)
        .update({
            ...data,
            ...(data.displayName !== undefined
                ? { searchName: normalizeSearchName(data.displayName) }
                : {}),
        });
    invalidateUserProfileCache(uid);
};

export const listUserProfiles = async (filters: {
    activeOnly?: boolean;
    roleId?: string;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: UserProfile[]; total: number }> => {
    let query: FirebaseFirestore.Query = collection();

    if (filters.roleId) {
        query = query.where('roleId', '==', filters.roleId);
    }

    if (filters.activeOnly) {
        query = query.where('isActive', '==', true);
    }

    /**
     * Pagina Firestore en ambos casos. Sin búsqueda ordena por `displayName`;
     * con búsqueda, rango por prefijo sobre `searchName`. Índices:
     * `[roleId, displayName]`, `[isActive, displayName]`,
     * `[roleId, isActive, displayName]` y sus equivalentes con `searchName`.
     *
     * `syncRoleUsersClaims` entra por aquí con `limit: 10000` para recorrer
     * todos los usuarios de un rol: sigue leyendo lo que necesita, ni más.
     */
    const ordered =
        applyNamePrefix(query, filters.search) ?? query.orderBy('displayName', 'asc');
    return paginateQuery(
        ordered,
        (doc) => ({ id: doc.id, ...doc.data() } as UserProfile),
        filters.page ?? 1,
        filters.limit ?? 100,
    );
};

export const countActiveAdmins = async (excludeUid?: string): Promise<number> => {
    const adminRoleSnapshot = await db()
        .collection('roles')
        .where('slug', '==', 'admin')
        .limit(1)
        .get();

    if (adminRoleSnapshot.empty) {
        return 0;
    }

    const adminRoleId = adminRoleSnapshot.docs[0].id;
    const snapshot = await collection()
        .where('roleId', '==', adminRoleId)
        .where('isActive', '==', true)
        .get();

    if (!excludeUid) {
        return snapshot.size;
    }
    return snapshot.docs.filter((doc) => doc.id !== excludeUid).length;
};

export const countUsersByRoleId = async (roleId: string): Promise<number> => {
    const snapshot = await collection()
        .where('roleId', '==', roleId)
        .where('isActive', '==', true)
        .get();
    return snapshot.size;
};
