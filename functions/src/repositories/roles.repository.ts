import { Role, RolePermission } from '../types';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

type RoleUpdateData = Partial<
    Pick<Role, 'name' | 'slug' | 'description' | 'permissions' | 'isActive' | 'isSystem'>
>;

const collection = () => db().collection('roles');

export const getRoleById = async (id: string): Promise<Role | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as Role;
};

export const getRoleBySlug = async (slug: string): Promise<Role | null> => {
    const snapshot = await collection()
        .where('slug', '==', slug)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Role;
};

export const listRoles = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Role[]; total: number }> => {
    const query = filters.activeOnly
        ? collection().where('isActive', '==', true)
        : collection();
    const snapshot = await query.get();
    let roles = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as Role),
    );

    if (filters.search) {
        const term = filters.search.toLowerCase();
        roles = roles.filter(
            (role) =>
                role.name.toLowerCase().includes(term) ||
                role.slug.toLowerCase().includes(term),
        );
    }

    roles.sort((a, b) => a.name.localeCompare(b.name));

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 100;
    return paginate(roles, page, limit);
};

export const createRole = async (data: {
    name: string;
    slug: string;
    description?: string;
    permissions: RolePermission[];
    isSystem: boolean;
    isActive: boolean;
}): Promise<Role> => {
    const timestamp = now();
    const payload = {
        ...data,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateRole = async (
    id: string,
    data: RoleUpdateData,
): Promise<Role | null> => {
    const existing = await getRoleById(id);
    if (!existing) {
        return null;
    }

    await collection().doc(id).update({
        ...data,
        updatedAt: now(),
    });

    return getRoleById(id);
};

export const slugExists = async (slug: string, excludeId?: string): Promise<boolean> => {
    const snapshot = await collection()
        .where('slug', '==', slug)
        .where('isActive', '==', true)
        .get();

    return snapshot.docs.some((doc) => doc.id !== excludeId);
};

export const countUsersByRoleId = async (roleId: string): Promise<number> => {
    const snapshot = await db()
        .collection('users')
        .where('roleId', '==', roleId)
        .where('isActive', '==', true)
        .get();
    return snapshot.size;
};

export const getAllRoles = async (): Promise<Role[]> => {
    const snapshot = await collection().get();
    return snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() } as Role),
    );
};
