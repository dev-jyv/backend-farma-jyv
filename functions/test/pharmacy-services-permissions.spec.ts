import {
    ALL_PERMISSION_AREAS,
    SYSTEM_ROLE_DEFINITIONS,
    buildAllWritePermissions,
    hasPermission,
} from '../src/constants/permissions';
import { PermissionArea, RolePermission } from '../src/types';

/**
 * `pharmacyServices` es un área con dos filos:
 *
 * - **Escritura solo admin.** El precio y la tasa de comisión de un servicio
 *   deciden cuánto se le paga al doctor. Como `manager` se define como "todos
 *   los permisos menos unos pocos", el área nueva se le hereda sola si no se
 *   excluye del `filter` — el mismo agujero que ya cuidan `cashSessions` y
 *   `expenses`.
 * - **Lectura hasta el cajero.** Sin `read` la caja no puede sincronizar el
 *   catálogo (`GET /pharmacy-services/sync`) ni cobrar un servicio, y eso no
 *   truena en el panel: se descubre en producción, en el mostrador.
 *
 * Estas pruebas son el candado sobre las dos cosas a la vez.
 */

const AREA: PermissionArea = 'pharmacyServices';

const permisosDe = (slug: keyof typeof SYSTEM_ROLE_DEFINITIONS): RolePermission[] =>
    SYSTEM_ROLE_DEFINITIONS[slug].permissions;

describe('ALL_PERMISSION_AREAS', () => {
    it('incluye el área pharmacyServices', () => {
        expect(ALL_PERMISSION_AREAS).toContain(AREA);
    });

    it('no repite áreas: un área duplicada duplicaría el permiso en cada rol', () => {
        expect(new Set(ALL_PERMISSION_AREAS).size).toBe(ALL_PERMISSION_AREAS.length);
    });

    it('buildAllWritePermissions la otorga en escritura (la base de admin)', () => {
        expect(buildAllWritePermissions()).toContainEqual({ area: AREA, level: 'write' });
    });
});

describe('rol admin', () => {
    it('tiene escritura sobre el catálogo de servicios', () => {
        expect(permisosDe('admin')).toContainEqual({ area: AREA, level: 'write' });
        expect(hasPermission(permisosDe('admin'), AREA, 'write')).toBe(true);
        expect(hasPermission(permisosDe('admin'), AREA, 'read')).toBe(true);
    });
});

describe('rol manager', () => {
    it('lee el catálogo pero NO lo escribe', () => {
        expect(hasPermission(permisosDe('manager'), AREA, 'read', 'manager')).toBe(true);
        expect(hasPermission(permisosDe('manager'), AREA, 'write', 'manager')).toBe(false);
    });

    it('declara el área exactamente una vez y en nivel read', () => {
        const declaradas = permisosDe('manager').filter(
            (permission) => permission.area === AREA,
        );
        expect(declaradas).toEqual([{ area: AREA, level: 'read' }]);
    });
});

describe('rol cashier', () => {
    it('lee el catálogo: sin esto la caja no puede sincronizar ni cobrar un servicio', () => {
        expect(permisosDe('cashier')).toContainEqual({ area: AREA, level: 'read' });
        expect(hasPermission(permisosDe('cashier'), AREA, 'read', 'cashier')).toBe(true);
    });

    it('no lo escribe: la comisión del doctor no se decide en el mostrador', () => {
        expect(hasPermission(permisosDe('cashier'), AREA, 'write', 'cashier')).toBe(false);
    });
});

describe('rol doctor', () => {
    it('no tiene ningún permiso sobre el área', () => {
        expect(permisosDe('doctor').some((permission) => permission.area === AREA)).toBe(false);
        expect(hasPermission(permisosDe('doctor'), AREA, 'read', 'doctor')).toBe(false);
        expect(hasPermission(permisosDe('doctor'), AREA, 'write', 'doctor')).toBe(false);
    });
});

describe('alcance de escritura del área', () => {
    /**
     * El conjunto exacto de roles que pueden escribir. Si alguien quita el
     * `filter` de `manager` o le sube el nivel al cajero, esta prueba truena en
     * vez de dejarlo pasar en silencio.
     */
    it('solo admin escribe pharmacyServices', () => {
        const conEscritura = (Object.keys(SYSTEM_ROLE_DEFINITIONS) as Array<
            keyof typeof SYSTEM_ROLE_DEFINITIONS
        >).filter((slug) =>
            permisosDe(slug).some(
                (permission) => permission.area === AREA && permission.level === 'write',
            ),
        );
        expect(conEscritura).toEqual(['admin']);
    });

    it('leen admin, cashier y manager', () => {
        const conLectura = (Object.keys(SYSTEM_ROLE_DEFINITIONS) as Array<
            keyof typeof SYSTEM_ROLE_DEFINITIONS
        >).filter((slug) => hasPermission(permisosDe(slug), AREA, 'read', slug));
        expect([...conLectura].sort()).toEqual(['admin', 'cashier', 'manager']);
    });
});

describe('rol manager - áreas sin ningún permiso', () => {
    /**
     * Complemento del test que ya existe en `cash-audit-permissions.spec.ts`:
     * aquel fija qué áreas quedan **fuera del rol**. Esta fija que
     * `pharmacyServices` no es una de ellas —está dentro, pero degradada a
     * lectura—, para que degradarla no se confunda con excluirla.
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
        expect(faltantes).not.toContain(AREA);
    });

    /**
     * El otro lado del candado: de todo lo que el gerente sí declara, el catálogo
     * de servicios es lo **único** que no está en escritura. Si mañana alguien
     * degrada otra área sin decidirlo, aquí se entera.
     */
    it('el catálogo de servicios es la única área del gerente en solo lectura', () => {
        const soloLectura = permisosDe('manager')
            .filter((permission) => permission.level === 'read')
            .map((permission) => permission.area);
        expect(soloLectura).toEqual([AREA]);
    });
});
