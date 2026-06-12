import { UserProfile } from '../types';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('users');

export const getUserProfile = async (uid: string): Promise<UserProfile | null> => {
    const doc = await collection().doc(uid).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as UserProfile;
};

export const createUserProfile = async (
    uid: string,
    data: Omit<UserProfile, 'id' | 'createdAt'>,
): Promise<UserProfile> => {
    const timestamp = now();
    const profile: Omit<UserProfile, 'id'> = {
        ...data,
        createdAt: timestamp,
    };
    await collection().doc(uid).set(profile);
    return { id: uid, ...profile };
};

export const updateUserProfile = async (
    uid: string,
    data: Partial<Pick<UserProfile, 'displayName' | 'roleId' | 'isActive'>>,
): Promise<void> => {
    await collection().doc(uid).update(data);
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

    const snapshot = await query.get();
    let users = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as UserProfile),
    );

    if (filters.search) {
        const term = filters.search.toLowerCase();
        users = users.filter(
            (user) =>
                user.displayName.toLowerCase().includes(term) ||
                user.email.toLowerCase().includes(term),
        );
    }

    users.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 100;
    return paginate(users, page, limit);
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
