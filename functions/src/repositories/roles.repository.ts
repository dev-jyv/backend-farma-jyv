import { Role, RolePermission } from '../types';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now } from '../utils/firestore';
import { applyNamePrefix, normalizeSearchName } from '../utils/search-name';

type RoleUpdateData = Partial<
    Pick<
        Role,
        'name' | 'slug' | 'description' | 'permissions' |
        'permissionsVersion' | 'isActive' | 'isSystem'
    >
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

    // Pagina Firestore: sin búsqueda por `name` (índice `[isActive, name]`); con
    // búsqueda, prefijo del nombre sobre `searchName` (`[isActive, searchName]`).
    const ordered =
        applyNamePrefix(query, filters.search) ?? query.orderBy('name', 'asc');
    return paginateQuery(
        ordered,
        (doc) => ({ id: doc.id, ...doc.data() } as Role),
        filters.page ?? 1,
        filters.limit ?? 100,
    );
};

export const createRole = async (data: {
    name: string;
    slug: string;
    description?: string;
    permissions: RolePermission[];
    permissionsVersion?: number;
    isSystem: boolean;
    isActive: boolean;
}): Promise<Role> => {
    const timestamp = now();
    const payload = {
        ...data,
        searchName: normalizeSearchName(data.name),
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
        ...(data.name !== undefined
            ? { searchName: normalizeSearchName(data.name) }
            : {}),
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
