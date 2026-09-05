import {
    createPharmacyServiceSchema,
    createServiceProviderSchema,
    serviceTaxModeSchema,
    serviceTypeSchema,
    updatePharmacyServiceSchema,
    updateServiceProviderSchema,
} from '../src/schemas/pharmacy-services';

/**
 * Reglas del catálogo de servicios y del padrón de doctores. Todo es validación
 * pura del schema: no toca Firestore ni el emulador.
 *
 * Los dos casos delicados son fiscales y de dinero: `taxMode` decide qué se le
 * declara al SAT por una consulta (exenta, tasa 0 o 16%), y `commissionRate` es
 * un **porcentaje** 0..100, no una fracción —un 0.3 aquí significa "0.3%", así
 * que el tope de 100 es lo único que impide capturar una comisión de 3000%.
 */

const servicio = (overrides: Record<string, unknown> = {}) =>
    createPharmacyServiceSchema.safeParse({
        code: 'CONS-GRAL',
        name: 'Consulta general',
        serviceType: 'consultation',
        price: 250,
        taxMode: 'exempt',
        hasIeps: false,
        commissionRate: 40,
        requiresPerformer: true,
        ...overrides,
    });

const doctor = (overrides: Record<string, unknown> = {}) =>
    createServiceProviderSchema.safeParse({
        name: 'Dra. Ana Ruiz',
        ...overrides,
    });

describe('serviceTypeSchema', () => {
    it('cubre exactamente las tres naturalezas de servicio', () => {
        expect([...serviceTypeSchema.options].sort()).toEqual([
            'consultation',
            'other',
            'procedure',
        ]);
    });

    it('rechaza una naturaleza inventada', () => {
        expect(serviceTypeSchema.safeParse('cirugia').success).toBe(false);
        expect(servicio({ serviceType: 'cirugia' }).success).toBe(false);
    });
});

describe('serviceTaxModeSchema', () => {
    it('cubre exactamente los tres regímenes de IVA', () => {
        expect([...serviceTaxModeSchema.options].sort()).toEqual([
            'exempt',
            'iva16',
            'zero',
        ]);
    });

    it('rechaza un régimen inventado', () => {
        expect(serviceTaxModeSchema.safeParse('iva8').success).toBe(false);
        expect(servicio({ taxMode: 'iva8' }).success).toBe(false);
    });

    it('no admite las banderas del producto (hasIva/hasIvaZero) como sustituto', () => {
        const parsed = servicio({ taxMode: undefined, hasIva: true });
        expect(parsed.success).toBe(false);
    });
});

describe('createPharmacyServiceSchema - campos obligatorios', () => {
    it.each(['code', 'name', 'serviceType', 'price', 'taxMode', 'hasIeps',
        'commissionRate', 'requiresPerformer'] as const)(
        'exige "%s"',
        (campo) => {
            expect(servicio({ [campo]: undefined }).success).toBe(false);
        },
    );

    it('acepta el alta mínima válida', () => {
        expect(servicio().success).toBe(true);
    });

    it('rechaza clave o nombre vacíos aunque vengan con espacios', () => {
        expect(servicio({ code: '   ' }).success).toBe(false);
        expect(servicio({ name: '   ' }).success).toBe(false);
    });
});

describe('createPharmacyServiceSchema - precio', () => {
    it('rechaza precio cero: un servicio gratuito no se cobra en la venta', () => {
        expect(servicio({ price: 0 }).success).toBe(false);
    });

    it('rechaza precio negativo', () => {
        expect(servicio({ price: -1 }).success).toBe(false);
    });

    it('rechaza más de dos decimales: no hay centavos partidos en el ticket', () => {
        expect(servicio({ price: 250.555 }).success).toBe(false);
        expect(servicio({ price: 250.55 }).success).toBe(true);
    });
});

describe('createPharmacyServiceSchema - comisión', () => {
    it('acepta 0: sin comisión es válido y distinto de "no configurado"', () => {
        expect(servicio({ commissionRate: 0 }).success).toBe(true);
    });

    it('acepta el tope de 100%', () => {
        expect(servicio({ commissionRate: 100 }).success).toBe(true);
    });

    it('rechaza una comisión negativa', () => {
        expect(servicio({ commissionRate: -1 }).success).toBe(false);
    });

    it('rechaza una comisión mayor a 100%', () => {
        expect(servicio({ commissionRate: 100.01 }).success).toBe(false);
        expect(servicio({ commissionRate: 150 }).success).toBe(false);
    });
});

describe('createPharmacyServiceSchema - IEPS', () => {
    it('un servicio con IEPS sin tasa no pasa: el desglose sería inventado', () => {
        expect(servicio({ hasIeps: true }).success).toBe(false);
    });

    it('una tasa sin hasIeps no pasa: nunca se aplicaría', () => {
        expect(servicio({ hasIeps: false, iepsRate: 0.08 }).success).toBe(false);
    });

    it('hasIeps con tasa sí pasa', () => {
        expect(servicio({ hasIeps: true, iepsRate: 0.08 }).success).toBe(true);
    });
});

describe('updatePharmacyServiceSchema', () => {
    it('acepta una edición parcial', () => {
        expect(updatePharmacyServiceSchema.safeParse({ price: 300 }).success).toBe(true);
    });

    it('la baja lógica viaja como isActive: false', () => {
        expect(updatePharmacyServiceSchema.safeParse({ isActive: false }).success).toBe(true);
    });

    it('mantiene las validaciones de valor en la edición', () => {
        expect(updatePharmacyServiceSchema.safeParse({ price: 0 }).success).toBe(false);
        expect(updatePharmacyServiceSchema.safeParse({ commissionRate: 101 }).success)
            .toBe(false);
        expect(updatePharmacyServiceSchema.safeParse({ taxMode: 'iva8' }).success).toBe(false);
        expect(updatePharmacyServiceSchema.safeParse({ serviceType: 'cirugia' }).success)
            .toBe(false);
    });

    it('una tasa de IEPS suelta exige mandar también hasIeps', () => {
        expect(updatePharmacyServiceSchema.safeParse({ iepsRate: 0.08 }).success).toBe(false);
        expect(updatePharmacyServiceSchema.safeParse({ hasIeps: true, iepsRate: 0.08 }).success)
            .toBe(true);
    });
});

describe('createServiceProviderSchema - cédula profesional', () => {
    it('el doctor mínimo es solo un nombre: no es usuario del sistema', () => {
        expect(doctor().success).toBe(true);
    });

    it.each(['1234567', '12345678'])('acepta la cédula de %s dígitos', (license) => {
        expect(doctor({ license }).success).toBe(true);
    });

    it.each([
        ['seis dígitos', '123456'],
        ['nueve dígitos', '123456789'],
        ['con letras', '12345AB'],
        ['vacía', ''],
        ['con guion', '1234-567'],
    ])('rechaza una cédula %s', (_caso, license) => {
        expect(doctor({ license }).success).toBe(false);
    });

    it('exige el nombre', () => {
        expect(doctor({ name: undefined }).success).toBe(false);
        expect(doctor({ name: '   ' }).success).toBe(false);
    });

    it('la comisión por omisión respeta el mismo rango 0..100', () => {
        expect(doctor({ defaultCommissionRate: 0 }).success).toBe(true);
        expect(doctor({ defaultCommissionRate: 100 }).success).toBe(true);
        expect(doctor({ defaultCommissionRate: -1 }).success).toBe(false);
        expect(doctor({ defaultCommissionRate: 101 }).success).toBe(false);
    });
});

describe('updateServiceProviderSchema', () => {
    it('acepta una edición parcial y la baja lógica', () => {
        expect(updateServiceProviderSchema.safeParse({ name: 'Dr. Luis' }).success).toBe(true);
        expect(updateServiceProviderSchema.safeParse({ isActive: false }).success).toBe(true);
    });

    it('sigue rechazando una cédula inválida al editar', () => {
        expect(updateServiceProviderSchema.safeParse({ license: '123' }).success).toBe(false);
    });
});
