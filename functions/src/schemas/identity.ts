import { z } from 'zod';
import { paginationFields } from './common';
import { ALL_PERMISSION_AREAS } from '../constants/permissions';
import { PermissionArea } from '../types';

/**
 * Derivado de `ALL_PERMISSION_AREAS` a propósito: cuando esto era una lista
 * literal aparte, cada área nueva (`patients`, `medicalRecords`,
 * `appointments`, `directCharges`, `pos`) quedaba fuera y la API rechazaba con
 * 400 cualquier rol personalizado que la usara, aunque el guard sí la
 * reconociera. Una sola fuente evita que se vuelvan a separar.
 */
const permissionAreaSchema = z.enum(
    ALL_PERMISSION_AREAS as [PermissionArea, ...PermissionArea[]],
);

const rolePermissionSchema = z.object({
    area: permissionAreaSchema,
    level: z.enum(['read', 'write']),
});

const passwordSchema = z
    .string()
    .min(8)
    .regex(/\d/, 'La contraseña debe incluir al menos un número');

const roleSlugSchema = z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'El slug solo puede contener minúsculas, números y guiones');

export const registerStaffSchema = z.object({
    email: z.string().email(),
    password: passwordSchema,
    displayName: z.string().min(2),
    roleId: z.string().min(1),
});

export const updateUserSchema = z.object({
    displayName: z.string().min(2).optional(),
    roleId: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
});

export const createRoleSchema = z.object({
    name: z.string().min(1),
    slug: roleSlugSchema,
    description: z.string().optional(),
    permissions: z.array(rolePermissionSchema).min(1),
});

export const updateRoleSchema = z.object({
    name: z.string().min(1).optional(),
    slug: roleSlugSchema.optional(),
    description: z.string().optional(),
    permissions: z.array(rolePermissionSchema).min(1).optional(),
    isActive: z.boolean().optional(),
});

export const listRolesQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const listUsersQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    roleId: z.string().min(1).optional(),
    ...paginationFields,
});
