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
    'patients',
    'medicalRecords',
    'appointments',
    'pos',
    'directCharges',
    'stockEntry',
    'cashSessions',
    'expenses',
    'pharmacyServices',
];

export const buildAllWritePermissions = (): RolePermission[] =>
    ALL_PERMISSION_AREAS.map((area) => ({ area, level: 'write' as PermissionLevel }));

/**
 * Compara dos conjuntos de permisos sin depender del orden en que se guardaron.
 * `updateRole` y `seedSystemRoles` lo usan para decidir si un rol cambió de
 * alcance y hay que subir `permissionsVersion` y reemitir los claims.
 */
export const permissionsEqual = (a: RolePermission[], b: RolePermission[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    const key = (permission: RolePermission) => `${permission.area}:${permission.level}`;
    const left = a.map(key).sort();
    const right = b.map(key).sort();
    return left.every((value, index) => value === right[index]);
};

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
        description: 'Caja: cobra y administra categorías, proveedores y facturas',
        /**
         * Rol de **mostrador**, no de panel: sin permiso de escritura el POS no
         * deja registrar una sola venta —`ensureShiftOpen()` corta al escanear— y
         * la pantalla de caja quedaba visible pero inservible.
         *
         * Ese permiso es `pos`, no `sales`: vender y administrar lo vendido son
         * atribuciones distintas. `pos:write` cubre levantar la venta, cobrar con
         * la terminal, mover y cerrar el turno y dar de alta al cliente en caja.
         * Devolver, reembolsar en Mercado Pago y configurar terminales se quedan
         * en `sales:write`, fuera del mostrador: ahí sale dinero de la caja hacia
         * el cliente. **Anular sí es de mostrador** (2026-09-05): equivocarse de
         * producto pasa con la fila enfrente, y exigir un admin empujaba a dejar
         * la venta mal registrada. Lo cubre `pos:write` y queda firmado con
         * `voidedBy`/`voidedAt` (ver `assertCanVoidSale`). El turno ajeno lo sigue bloqueando
         * `assertCanAccessSession`, aunque el área alcance.
         *
         * `sales:read` se conserva para consultar ventas y reimprimir tickets.
         *
         * `products` en escritura (2026-09-03): el POS suma un módulo de edición
         * de catálogo (alta/edición de producto, local-first en SQLite, sube al
         * sincronizar) que el cajero también opera desde el mostrador —no solo
         * busca el producto para vender, también corrige precio/datos o da de
         * alta uno nuevo antes de recibir mercancía. `inventory` sigue en
         * lectura: resolver lote/caducidad (FEFO) es lo único que la venta
         * necesita ahí. El libro de control comparte ese `inventory:read`, así
         * que la pantalla del POS lo resguarda con `inventory:write` —el cajero
         * no lo ve, el gerente sí— sin quitarle al cajero lo que sí necesita
         * para vender.
         *
         * `categories`, `suppliers` e `invoices` van en escritura: son los tres
         * únicos módulos del panel que este rol tiene habilitados en la
         * navegación (`ROLE_ALLOWED_SEGMENTS.cashier`), y entra a administrarlos,
         * no solo a consultarlos.
         */
        permissions: [
            { area: 'pos', level: 'write' },
            { area: 'sales', level: 'read' },
            { area: 'products', level: 'write' },
            { area: 'categories', level: 'write' },
            { area: 'suppliers', level: 'write' },
            { area: 'invoices', level: 'write' },
            /** Subir el comprobante (PDF/imagen) al dar de alta una factura desde caja. */
            { area: 'uploads', level: 'write' },
            { area: 'inventory', level: 'read' },
            /**
             * Recibir mercancía contra factura, desde la caja. No es
             * `inventory:write`: eso le abriría conteos, salidas y el libro de
             * control, que no son del mostrador.
             */
            { area: 'stockEntry', level: 'write' },
            /**
             * Catálogo de servicios y padrón de doctores, **solo lectura**: la
             * caja los baja con `GET /pharmacy-services/sync` y
             * `GET /service-providers/sync` para poder cobrar una consulta sin
             * red. Quién cobra cuánto de comisión lo decide el administrador,
             * no el mostrador, así que aquí no hay escritura.
             */
            { area: 'pharmacyServices', level: 'read' },
        ],
    },
    manager: {
        name: 'Gerente',
        description: 'Acceso operativo completo excepto usuarios, dashboard, expediente clínico y auditoría de caja',
        /**
         * `medicalRecords` se excluye a propósito: la nota clínica es dato
         * sensible del paciente (NOM-004) y el gerente de farmacia no la
         * necesita para operar. Solo admin y doctor la leen.
         *
         * `cashSessions`/`expenses` también se excluyen a propósito: son la
         * auditoría global de cortes de caja y gastos de TODAS las cajas —el
         * pedido explícito fue "exclusivo de administrador"—, y como este rol
         * se define como "todo menos unas pocas áreas", cualquier área nueva
         * se heredaría sola si no se excluye aquí.
         *
         * `pharmacyServices` se excluye del `filter` por lo mismo, pero no queda
         * fuera del rol: se vuelve a agregar abajo **en lectura**. La escritura
         * (precio y tasa de comisión de un servicio: cuánto se le paga al
         * doctor) es exclusiva de administrador; la lectura sí la necesita el
         * gerente para consultar el catálogo.
         */
        permissions: [
            ...buildAllWritePermissions().filter(
                (permission) => permission.area !== 'users' &&
                    permission.area !== 'dashboard' &&
                    permission.area !== 'medicalRecords' &&
                    permission.area !== 'cashSessions' &&
                    permission.area !== 'expenses' &&
                    permission.area !== 'pharmacyServices',
            ),
            { area: 'pharmacyServices', level: 'read' },
        ],
    },
    doctor: {
        name: 'Doctor',
        description: 'Consultorio: pacientes, expediente clínico y agenda de citas',
        permissions: [
            { area: 'doctor', level: 'write' },
            { area: 'patients', level: 'write' },
            { area: 'medicalRecords', level: 'write' },
            { area: 'appointments', level: 'write' },
            { area: 'products', level: 'read' },
        ],
    },
};
