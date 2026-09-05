import * as admin from 'firebase-admin';
import { Role, RolePermission } from '../types';
import {
    permissionsEqual,
    SYSTEM_ROLE_DEFINITIONS,
    SYSTEM_ROLE_SLUGS,
    SystemRoleSlug,
} from '../constants/permissions';
import { badRequest, notFound, unauthorized } from '../utils/errors';
import { buildListMeta, parsePagination } from '../utils/pagination';
import * as rolesRepo from '../repositories/roles.repository';
import { AuditActor, diffFields, recordAudit } from './audit.service';
import {
    invalidateUserProfileCache,
    listUserProfiles,
    updateUserProfile,
} from '../repositories/users.repository';

/**
 * Versión vigente de los permisos del rol. Los documentos anteriores a la
 * migración no traen el campo y valen 1: cualquier cambio posterior sube a 2 y
 * deja de coincidir con los claims viejos.
 */
export const rolePermissionsVersion = (
    role: Pick<Role, 'permissionsVersion'>,
): number => role.permissionsVersion ?? 1;

/**
 * Los claims llevan el rol completo (no solo el id) para que el guard de
 * autenticación pueda construir `req.authUser` sin leer la colección `roles`
 * en cada request.
 *
 * Van sellados con `permissionsVersion`: el guard exige que ese número
 * coincida con el del perfil (que sí lee siempre) antes de confiar en los
 * claims. Sin ese sello, quitarle un permiso a un rol no surtía efecto hasta
 * que el usuario refrescara su token — hasta una hora conservando el acceso
 * que se le acababa de retirar. Al no coincidir, el guard cae a la lectura de
 * `roles` y aplica los permisos nuevos en el siguiente request.
 */
export const syncUserClaims = async (uid: string, role: Role): Promise<void> => {
    await admin.auth().setCustomUserClaims(uid, {
        roleId: role.id,
        roleSlug: role.slug,
        roleName: role.name,
        permissions: role.permissions,
        permissionsVersion: rolePermissionsVersion(role),
    });
};

/**
 * Asigna el rol a un usuario: claims + sello en el perfil. Ambos lados tienen
 * que quedar escritos o el guard descarta los claims (comportamiento seguro:
 * degrada a una lectura extra, nunca a un permiso de más).
 */
export const applyRoleToUser = async (uid: string, role: Role): Promise<void> => {
    await syncUserClaims(uid, role);
    await updateUserProfile(uid, {
        roleId: role.id,
        permissionsVersion: rolePermissionsVersion(role),
    });
};

export const syncRoleUsersClaims = async (roleId: string): Promise<number> => {
    const role = await rolesRepo.getRoleById(roleId);
    if (!role) {
        return 0;
    }

    const { items: roleUsers } = await listUserProfiles({
        roleId,
        activeOnly: true,
        page: 1,
        limit: 10000,
    });

    const CHUNK_SIZE = 20;
    for (let i = 0; i < roleUsers.length; i += CHUNK_SIZE) {
        const chunk = roleUsers.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map((user) => applyRoleToUser(user.id, role)));
    }

    return roleUsers.length;
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
    actor?: AuditActor;
}) => {
    const slug = normalizeSlug(input.slug);
    validatePermissions(input.permissions);

    if (await rolesRepo.slugExists(slug)) {
        throw badRequest('Ya existe un rol activo con ese slug');
    }

    const created = await rolesRepo.createRole({
        name: input.name.trim(),
        slug,
        description: input.description?.trim(),
        permissions: input.permissions,
        permissionsVersion: 1,
        isSystem: false,
        isActive: true,
    });

    await recordAudit({
        action: 'role.created',
        entity: 'role',
        entityId: created.id,
        summary: `Rol ${created.name} (${created.slug}) creado con ` +
            `${created.permissions.length} permisos`,
        userId: input.actor?.userId ?? 'system',
        roleSlug: input.actor?.roleSlug ?? null,
        metadata: { permissions: created.permissions },
    });

    return created;
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
    actor?: AuditActor,
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

    // Un cambio de permisos es un cambio de alcance de acceso: se audita aparte de
    // los cambios cosméticos de nombre/descripción, y sube la versión para
    // invalidar los claims ya emitidos.
    const permissionsChanged = input.permissions !== undefined &&
        !permissionsEqual(existing.permissions, input.permissions);

    const updated = await rolesRepo.updateRole(id, {
        name: input.name?.trim(),
        slug: input.slug !== undefined ? normalizeSlug(input.slug) : undefined,
        description: input.description?.trim(),
        permissions: input.permissions,
        permissionsVersion: permissionsChanged
            ? rolePermissionsVersion(existing) + 1
            : undefined,
        isActive: input.isActive,
    });

    if (!updated) {
        throw notFound('Rol');
    }

    if (permissionsChanged) {
        await syncRoleUsersClaims(id);
    }

    await recordAudit({
        action: permissionsChanged ? 'role.permissions_changed' : 'role.updated',
        entity: 'role',
        entityId: id,
        summary: permissionsChanged
            ? `Permisos del rol ${updated.name} actualizados ` +
                `(${existing.permissions.length} → ${updated.permissions.length})`
            : `Rol ${updated.name} actualizado`,
        userId: actor?.userId ?? 'system',
        roleSlug: actor?.roleSlug ?? null,
        changes: permissionsChanged
            ? {
                permissions: {
                    before: existing.permissions,
                    after: updated.permissions,
                },
            }
            : diffFields(
                existing as unknown as Record<string, unknown>,
                { name: updated.name, slug: updated.slug, isActive: updated.isActive },
                ['name', 'slug', 'isActive'],
            ),
    });

    return updated;
};

export const deleteRole = async (id: string, actor?: AuditActor) =>
    updateRole(id, { isActive: false }, actor);

/**
 * Mapa de los valores del campo legado `role` (string suelto en el documento
 * del usuario) al slug del rol. Es la única fuente: la migración de usuarios y
 * la resolución de rol en login leen de aquí, para que no se separen.
 */
const LEGACY_ROLE_SLUG_MAP: Record<string, string> = {
    admin: 'admin',
    inventory: 'manager',
    manager: 'manager',
    cashier: 'cashier',
    doctor: 'doctor',
};

export interface RoleMigrationReport {
    roleIds: Record<SystemRoleSlug, string>;
    /** Roles del sistema creados en esta corrida. */
    rolesCreated: SystemRoleSlug[];
    /** Roles del sistema cuyos permisos cambiaron respecto a la definición. */
    rolesUpdated: SystemRoleSlug[];
    /** Roles (incluidos los personalizados) a los que se les puso versión inicial. */
    rolesBackfilled: number;
    /** Roles personalizados que vendían con `sales` y recibieron `pos:write`. */
    rolesGrantedPos: string[];
    usersMigrated: number;
    usersSkipped: Array<{ uid: string; reason: string }>;
}

/**
 * Crea o actualiza los roles del sistema a partir de `SYSTEM_ROLE_DEFINITIONS`.
 *
 * Cuando los permisos de la definición ya no coinciden con lo guardado, sube
 * `permissionsVersion` y reemite los claims de los usuarios asignados: cambiar
 * la definición en código sin reemitir dejaba a los usuarios con el alcance
 * viejo mientras su token siguiera vivo.
 */
export const seedSystemRoles = async (): Promise<{
    roleIds: Record<SystemRoleSlug, string>;
    created: SystemRoleSlug[];
    updated: SystemRoleSlug[];
}> => {
    const roleIds: Partial<Record<SystemRoleSlug, string>> = {};
    const created: SystemRoleSlug[] = [];
    const updated: SystemRoleSlug[] = [];

    for (const slug of SYSTEM_ROLE_SLUGS) {
        const definition = SYSTEM_ROLE_DEFINITIONS[slug];
        const existing = await rolesRepo.getRoleBySlug(slug);

        if (existing) {
            const permissionsChanged = !permissionsEqual(
                existing.permissions,
                definition.permissions,
            );

            await rolesRepo.updateRole(existing.id, {
                name: definition.name,
                description: definition.description,
                permissions: definition.permissions,
                permissionsVersion: permissionsChanged
                    ? rolePermissionsVersion(existing) + 1
                    : rolePermissionsVersion(existing),
                isSystem: true,
                isActive: true,
            });

            roleIds[slug] = existing.id;

            if (permissionsChanged) {
                updated.push(slug);
                await syncRoleUsersClaims(existing.id);
            }
            continue;
        }

        const role = await rolesRepo.createRole({
            name: definition.name,
            slug,
            description: definition.description,
            permissions: definition.permissions,
            permissionsVersion: 1,
            isSystem: true,
            isActive: true,
        });
        roleIds[slug] = role.id;
        created.push(slug);
    }

    return { roleIds: roleIds as Record<SystemRoleSlug, string>, created, updated };
};

/**
 * Pone `permissionsVersion: 1` en los roles anteriores a la migración —
 * incluidos los personalizados, que `seedSystemRoles` no toca. Idempotente.
 */
export const backfillRolePermissionsVersions = async (): Promise<number> => {
    const roles = await rolesRepo.getAllRoles();
    const pending = roles.filter((role) => role.permissionsVersion === undefined);

    for (const role of pending) {
        await rolesRepo.updateRole(role.id, { permissionsVersion: 1 });
    }

    return pending.length;
};

/**
 * Al separarse el mostrador de la administración de ventas, `sales:write` dejó
 * de habilitar el POS: ahora hace falta `pos:write`. Los roles personalizados
 * que ya vendían se quedarían sin poder cobrar tras el despliegue, así que se
 * les concede `pos` al mismo nivel que tenían en `sales`.
 *
 * Solo toca roles **no** del sistema (los del sistema los define
 * `SYSTEM_ROLE_DEFINITIONS`) y es idempotente: si el rol ya trae `pos`, se
 * deja como está. No se le quita `sales` a nadie — retirar una atribución a un
 * rol que alguien configuró a mano es decisión del administrador, no de una
 * migración.
 */
export const backfillPosPermission = async (): Promise<string[]> => {
    const roles = await rolesRepo.getAllRoles();
    const granted: string[] = [];

    for (const role of roles) {
        if (role.isSystem || !role.isActive) {
            continue;
        }

        const sales = role.permissions.find((permission) => permission.area === 'sales');
        const hasPos = role.permissions.some((permission) => permission.area === 'pos');
        if (sales?.level !== 'write' || hasPos) {
            continue;
        }

        await rolesRepo.updateRole(role.id, {
            permissions: [...role.permissions, { area: 'pos', level: 'write' }],
            permissionsVersion: rolePermissionsVersion(role) + 1,
        });
        await syncRoleUsersClaims(role.id);
        granted.push(role.slug);
    }

    return granted;
};

/**
 * Migra los usuarios al esquema de roles: resuelve `roleId` (desde el campo
 * legado `role` si hace falta), borra el campo legado y sella claims y perfil
 * con la versión de permisos vigente.
 *
 * Los usuarios que no se pueden resolver se devuelven en el reporte en vez de
 * saltarse en silencio: un usuario sin rol no puede autenticarse, y sin este
 * listado el operador no se entera hasta que alguien reporta el bloqueo.
 */
export const migrateUsersToRoleIds = async (
    roleIds: Record<SystemRoleSlug, string>,
): Promise<{ migrated: number; skipped: Array<{ uid: string; reason: string }> }> => {
    const snapshot = await admin.firestore().collection('users').get();

    // Se precargan todos los roles: leer el rol dentro del loop era una lectura
    // por usuario contra un catálogo de un puñado de documentos.
    const roles = await rolesRepo.getAllRoles();
    const rolesById = new Map(roles.map((role) => [role.id, role]));
    const rolesBySlug = new Map(roles.map((role) => [role.slug, role]));

    const skipped: Array<{ uid: string; reason: string }> = [];
    let migrated = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        const legacyRole = typeof data.role === 'string' ? data.role : undefined;

        let role: Role | undefined;

        if (typeof data.roleId === 'string') {
            role = rolesById.get(data.roleId);
            if (!role) {
                skipped.push({ uid: doc.id, reason: `roleId inexistente: ${data.roleId}` });
                continue;
            }
        } else if (legacyRole) {
            const slug = LEGACY_ROLE_SLUG_MAP[legacyRole] ?? legacyRole;
            const systemId = roleIds[slug as SystemRoleSlug];
            role = (systemId ? rolesById.get(systemId) : undefined) ?? rolesBySlug.get(slug);
            if (!role) {
                skipped.push({ uid: doc.id, reason: `rol legado sin equivalente: ${legacyRole}` });
                continue;
            }
        } else {
            skipped.push({ uid: doc.id, reason: 'sin roleId ni rol legado' });
            continue;
        }

        if (!role.isActive) {
            skipped.push({ uid: doc.id, reason: `rol inactivo: ${role.slug}` });
            continue;
        }

        const update: Record<string, unknown> = {
            roleId: role.id,
            permissionsVersion: rolePermissionsVersion(role),
        };
        if (legacyRole !== undefined) {
            update.role = admin.firestore.FieldValue.delete();
        }

        await doc.ref.update(update);
        invalidateUserProfileCache(doc.id);

        // Los usuarios desactivados no reciben claims: su token no debe volver
        // a validar, y el guard los rechaza por `isActive` de todos modos.
        if (data.isActive !== false) {
            await syncUserClaims(doc.id, role);
        }

        migrated += 1;
    }

    return { migrated, skipped };
};

/**
 * Migración completa de roles, en el orden en que tiene que correr:
 * sembrar los roles del sistema, rellenar la versión de permisos faltante y
 * después sellar a los usuarios. Es idempotente: volver a correrla no cambia
 * nada si ya está aplicada.
 */
export const runRoleMigration = async (): Promise<RoleMigrationReport> => {
    const { roleIds, created, updated } = await seedSystemRoles();
    const rolesBackfilled = await backfillRolePermissionsVersions();
    const rolesGrantedPos = await backfillPosPermission();
    const { migrated, skipped } = await migrateUsersToRoleIds(roleIds);

    return {
        roleIds,
        rolesCreated: created,
        rolesUpdated: updated,
        rolesBackfilled,
        rolesGrantedPos,
        usersMigrated: migrated,
        usersSkipped: skipped,
    };
};

export const getActiveRoleById = async (roleId: string) => {
    const role = await rolesRepo.getRoleById(roleId);
    if (!role || !role.isActive) {
        throw badRequest('Rol inválido o inactivo');
    }
    return role;
};

const resolveSlugFromLegacyRole = (legacyRole?: string): string | null => {
    if (!legacyRole) {
        return null;
    }
    return LEGACY_ROLE_SLUG_MAP[legacyRole] ?? legacyRole;
};

const resolveRoleBySlug = async (slug: string) => {
    const role = await rolesRepo.getRoleBySlug(slug);
    if (role?.isActive) {
        return role;
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
