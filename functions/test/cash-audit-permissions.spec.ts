import {
    ALL_PERMISSION_AREAS,
    SYSTEM_ROLE_DEFINITIONS,
    buildAllWritePermissions,
    hasPermission,
} from '../src/constants/permissions';
import { PermissionArea, PermissionLevel, RolePermission } from '../src/types';

/**
 * La auditoría de cortes de caja y el módulo de gastos son **exclusivos de
 * administrador**. El riesgo real no está en `admin` ni en `cashier`, está en
 * `manager`: ese rol se define como "todos los permisos menos unos pocos", así
 * que si alguien quita el `filter` de `cashSessions`/`expenses` el gerente
 * hereda solo la auditoría global de todas las cajas sin que nadie lo note.
 * Estas pruebas son el candado sobre esa exclusión.
 */

const AREAS_DE_AUDITORIA: PermissionArea[] = ['cashSessions', 'expenses'];

const permisosDe = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS): RolePermission[] =>
    SYSTEM_ROLE_DEFINITIONS[slug].permissions;

describe('ALL_PERMISSION_AREAS', () => {
    it.each(AREAS_DE_AUDITORIA)('incluye el área "%s"', (area) => {
        expect(ALL_PERMISSION_AREAS).toContain(area);
    });

    it('no repite áreas: un área duplicada duplicaría el permiso en cada rol', () => {
        expect(new Set(ALL_PERMISSION_AREAS).size).toBe(ALL_PERMISSION_AREAS.length);
    });

    it('buildAllWritePermissions otorga escritura sobre las dos áreas nuevas', () => {
        const todos = buildAllWritePermissions();
        for (const area of AREAS_DE_AUDITORIA) {
            expect(todos).toContainEqual({ area, level: 'write' });
        }
    });
});

describe('rol admin', () => {
    it.each(AREAS_DE_AUDITORIA)('tiene escritura sobre "%s"', (area) => {
        expect(permisosDe('admin')).toContainEqual({ area, level: 'write' });
    });

    it.each(AREAS_DE_AUDITORIA)('lee y escribe "%s" a través de hasPermission', (area) => {
        expect(hasPermission(permisosDe('admin'), area, 'read')).toBe(true);
        expect(hasPermission(permisosDe('admin'), area, 'write')).toBe(true);
    });
});

describe.each(['manager', 'cashier', 'doctor'] as const)('rol %s', (slug) => {
    it.each(AREAS_DE_AUDITORIA)('no declara el área "%s"', (area) => {
        expect(permisosDe(slug).some((permission) => permission.area === area)).toBe(false);
    });

    it.each<[PermissionArea, PermissionLevel]>([
        ['cashSessions', 'read'],
        ['cashSessions', 'write'],
        ['expenses', 'read'],
        ['expenses', 'write'],
    ])('hasPermission niega %s:%s', (area, level) => {
        expect(hasPermission(permisosDe(slug), area, level, slug)).toBe(false);
    });
});

describe('rol manager - alcance exacto', () => {
    /**
     * El gerente es "todo menos estas cinco". Si alguien agrega un área nueva y
     * el pedido es que el gerente no la vea, esta prueba lo obliga a decidirlo
     * a propósito en vez de heredarla en silencio.
     */
    it('excluye exactamente usuarios, dashboard, expediente y la auditoría de caja', () => {
        const declaradas = permisosDe('manager').map((permission) => permission.area);
        const faltantes = ALL_PERMISSION_AREAS.filter((area) => !declaradas.includes(area));
        expect([...faltantes].sort()).toEqual([
            'cashSessions',
            'dashboard',
            'expenses',
            'medicalRecords',
            'users',
        ]);
    });

    it('conserva escritura sobre lo demás, incluida la caja del mostrador', () => {
        expect(permisosDe('manager')).toContainEqual({ area: 'pos', level: 'write' });
        expect(permisosDe('manager')).toContainEqual({ area: 'inventory', level: 'write' });
    });
});

describe('hasPermission - atajo de admin', () => {
    it('el slug admin manda sobre el arreglo de permisos', () => {
        // Un admin con permisos vacíos (rol recién migrado) sigue entrando: el
        // atajo por slug es lo que evita dejar la instalación sin dueño.
        expect(hasPermission([], 'cashSessions', 'write', 'admin')).toBe(true);
        expect(hasPermission([], 'expenses', 'read', 'admin')).toBe(true);
    });

    it('sin slug admin, un arreglo vacío no abre nada', () => {
        expect(hasPermission([], 'cashSessions', 'read')).toBe(false);
        expect(hasPermission([], 'expenses', 'read')).toBe(false);
    });

    it('lectura no alcanza para escribir la revisión del ajuste', () => {
        const soloLectura: RolePermission[] = [{ area: 'cashSessions', level: 'read' }];
        expect(hasPermission(soloLectura, 'cashSessions', 'read')).toBe(true);
        expect(hasPermission(soloLectura, 'cashSessions', 'write')).toBe(false);
    });
});
