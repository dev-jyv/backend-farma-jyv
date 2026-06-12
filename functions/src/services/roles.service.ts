import * as admin from 'firebase-admin';
import { RolePermission } from '../types';
import {
    SYSTEM_ROLE_DEFINITIONS,
    SYSTEM_ROLE_SLUGS,
    SystemRoleSlug,
} from '../constants/permissions';
import { badRequest, notFound, unauthorized } from '../utils/errors';
import { buildListMeta, parsePagination } from '../utils/pagination';
import * as rolesRepo from '../repositories/roles.repository';
import { listUserProfiles, updateUserProfile } from '../repositories/users.repository';

export const syncUserClaims = async (
    uid: string,
    roleId: string,
    roleSlug: string,
    permissions: RolePermission[],
): Promise<void> => {
    await admin.auth().setCustomUserClaims(uid, {
        roleId,
        roleSlug,
        permissions,
    });
};

export const syncRoleUsersClaims = async (roleId: string): Promise<void> => {
    const role = await rolesRepo.getRoleById(roleId);
    if (!role) {
        return;
    }

    const { items: users } = await listUserProfiles({
        activeOnly: true,
        page: 1,
        limit: 10000,
    });

    const roleUsers = users.filter((user) => user.roleId === roleId);

    await Promise.all(
        roleUsers.map((user) =>
            syncUserClaims(user.id, role.id, role.slug, role.permissions),
        ),
    );
};

const normalizeSlug = (slug: string): string => slug.trim().toLowerCase();

const validatePermissions = (permissions: RolePermission[]): void => {
    if (permissions.length === 0) {
        throw badRequest('El rol debe tener al menos un permiso');
    }
};

export const listRoles = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}) => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await rolesRepo.listRoles({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getRole = async (id: string) => {
    const role = await rolesRepo.getRoleById(id);
    if (!role) {
        throw notFound('Rol');
    }
    return role;
};

export const createRole = async (input: {
    name: string;
    slug: string;
    description?: string;
    permissions: RolePermission[];
}) => {
    const slug = normalizeSlug(input.slug);
    validatePermissions(input.permissions);

    if (await rolesRepo.slugExists(slug)) {
        throw badRequest('Ya existe un rol activo con ese slug');
    }

    return rolesRepo.createRole({
        name: input.name.trim(),
        slug,
        description: input.description?.trim(),
        permissions: input.permissions,
        isSystem: false,
        isActive: true,
    });
};

export const updateRole = async (
    id: string,
    input: {
        name?: string;
        slug?: string;
        description?: string;
        permissions?: RolePermission[];
        isActive?: boolean;
    },
) => {
    const existing = await rolesRepo.getRoleById(id);
    if (!existing) {
        throw notFound('Rol');
    }

    const slugChanged = input.slug !== undefined
        && normalizeSlug(input.slug) !== existing.slug;
    if (existing.isSystem && slugChanged) {
        throw badRequest('No se puede cambiar el slug de un rol del sistema');
    }

    if (input.isActive === false) {
        if (existing.isSystem) {
            throw badRequest('No se puede desactivar un rol del sistema');
        }

        const assignedUsers = await rolesRepo.countUsersByRoleId(id);
        if (assignedUsers > 0) {
            throw badRequest('No se puede desactivar un rol con usuarios activos asignados');
        }
    }

    if (input.slug !== undefined) {
        const slug = normalizeSlug(input.slug);
        if (await rolesRepo.slugExists(slug, id)) {
            throw badRequest('Ya existe un rol activo con ese slug');
        }
    }

    if (input.permissions !== undefined) {
        validatePermissions(input.permissions);
    }

    const updated = await rolesRepo.updateRole(id, {
        name: input.name?.trim(),
        slug: input.slug !== undefined ? normalizeSlug(input.slug) : undefined,
        description: input.description?.trim(),
        permissions: input.permissions,
        isActive: input.isActive,
    });

    if (!updated) {
        throw notFound('Rol');
    }

    if (input.permissions !== undefined) {
        await syncRoleUsersClaims(id);
    }

    return updated;
};

export const deleteRole = async (id: string) => updateRole(id, { isActive: false });

export const seedSystemRoles = async (): Promise<Record<SystemRoleSlug, string>> => {
    const roleIds: Partial<Record<SystemRoleSlug, string>> = {};

    for (const slug of SYSTEM_ROLE_SLUGS) {
        const definition = SYSTEM_ROLE_DEFINITIONS[slug];
        const existing = await rolesRepo.getRoleBySlug(slug);

        if (existing) {
            await rolesRepo.updateRole(existing.id, {
                name: definition.name,
                description: definition.description,
                permissions: definition.permissions,
                isSystem: true,
                isActive: true,
            });
            roleIds[slug] = existing.id;
            continue;
        }

        const created = await rolesRepo.createRole({
            name: definition.name,
            slug,
            description: definition.description,
            permissions: definition.permissions,
            isSystem: true,
            isActive: true,
        });
        roleIds[slug] = created.id;
    }

    return roleIds as Record<SystemRoleSlug, string>;
};

export const migrateUsersToRoleIds = async (
    roleIds: Record<SystemRoleSlug, string>,
): Promise<number> => {
    const snapshot = await admin.firestore().collection('users').get();
    let migrated = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        let roleId = data.roleId as string | undefined;

        if (!roleId && data.role) {
            const legacyRole = data.role as string;
            const roleMap: Record<string, SystemRoleSlug> = {
                admin: 'admin',
                inventory: 'manager',
                cashier: 'cashier',
            };
            const mappedSlug = roleMap[legacyRole];
            if (mappedSlug) {
                roleId = roleIds[mappedSlug];
            }
        }

        if (!roleId) {
            continue;
        }

        const role = await rolesRepo.getRoleById(roleId);
        if (!role) {
            continue;
        }

        await updateUserProfile(doc.id, { roleId });
        await doc.ref.update({
            roleId,
            role: admin.firestore.FieldValue.delete(),
        });

        if (data.isActive !== false) {
            await syncUserClaims(doc.id, role.id, role.slug, role.permissions);
        }

        migrated += 1;
    }

    return migrated;
};

export const getActiveRoleById = async (roleId: string) => {
    const role = await rolesRepo.getRoleById(roleId);
    if (!role || !role.isActive) {
        throw badRequest('Rol inválido o inactivo');
    }
    return role;
};

const LEGACY_ROLE_SLUG_MAP: Record<string, string> = {
    admin: 'admin',
    inventory: 'manager',
    cashier: 'cashier',
};

const resolveSlugFromLegacyRole = (legacyRole?: string): string | null => {
    if (!legacyRole) {
        return null;
    }
    return LEGACY_ROLE_SLUG_MAP[legacyRole] ?? legacyRole;
};

const resolveRoleBySlug = async (slug: string) => {
    let role = await rolesRepo.getRoleBySlug(slug);
    if (role?.isActive) {
        return role;
    }

    if ((SYSTEM_ROLE_SLUGS as readonly string[]).includes(slug)) {
        await seedSystemRoles();
        role = await rolesRepo.getRoleBySlug(slug);
        if (role?.isActive) {
            return role;
        }
    }

    return null;
};

export const resolveActiveUserRole = async (input: {
    roleId?: string;
    legacyRole?: string;
    roleSlug?: string;
}) => {
    if (input.roleId) {
        const roleById = await rolesRepo.getRoleById(input.roleId);
        if (roleById?.isActive) {
            return roleById;
        }
    }

    const slug = resolveSlugFromLegacyRole(input.legacyRole) ?? input.roleSlug ?? null;
    if (slug) {
        const role = await resolveRoleBySlug(slug);
        if (role) {
            return role;
        }
    }

    throw unauthorized('Usuario no autorizado');
};

export const getAdminRoleId = async (): Promise<string | null> => {
    const adminRole = await rolesRepo.getRoleBySlug('admin');
    return adminRole?.id ?? null;
};
