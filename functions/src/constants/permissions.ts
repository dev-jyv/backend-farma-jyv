import { PermissionArea, PermissionLevel, RolePermission } from '../types';

export const ALL_PERMISSION_AREAS: PermissionArea[] = [
    'dashboard',
    'users',
    'sales',
    'categories',
    'products',
    'suppliers',
    'inventory',
    'invoices',
    'uploads',
    'doctor',
];

export const isValidPermissionArea = (area: string): area is PermissionArea =>
    ALL_PERMISSION_AREAS.includes(area as PermissionArea);

export const isValidPermissionLevel = (level: string): level is PermissionLevel =>
    level === 'read' || level === 'write';

export const buildAllWritePermissions = (): RolePermission[] =>
    ALL_PERMISSION_AREAS.map((area) => ({ area, level: 'write' as PermissionLevel }));

export const hasPermission = (
    permissions: RolePermission[],
    area: PermissionArea,
    level: PermissionLevel = 'write',
    roleSlug?: string,
): boolean => {
    if (roleSlug === 'admin') {
        return true;
    }

    const permission = permissions.find((item) => item.area === area);
    if (!permission) {
        return false;
    }

    if (level === 'read') {
        return permission.level === 'read' || permission.level === 'write';
    }

    return permission.level === 'write';
};

export const SYSTEM_ROLE_SLUGS = ['admin', 'cashier', 'manager', 'doctor'] as const;

export type SystemRoleSlug = typeof SYSTEM_ROLE_SLUGS[number];

export const SYSTEM_ROLE_DEFINITIONS: Record<SystemRoleSlug, {
    name: string;
    description: string;
    permissions: RolePermission[];
}> = {
    admin: {
        name: 'Administrador',
        description: 'Acceso completo a todos los módulos',
        permissions: buildAllWritePermissions(),
    },
    cashier: {
        name: 'Cajero',
        description: 'Acceso al punto de venta y lectura de catálogo',
        permissions: [
            { area: 'sales', level: 'write' },
            { area: 'products', level: 'read' },
            { area: 'categories', level: 'read' },
            { area: 'inventory', level: 'read' },
        ],
    },
    manager: {
        name: 'Gerente',
        description: 'Acceso operativo completo excepto usuarios y dashboard',
        permissions: buildAllWritePermissions().filter(
            (permission) => permission.area !== 'users' && permission.area !== 'dashboard',
        ),
    },
    doctor: {
        name: 'Doctor',
        description: 'Acceso al módulo médico pendiente',
        permissions: [{ area: 'doctor', level: 'write' }],
    },
};
