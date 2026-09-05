import {
    closeCashSessionSchema,
    createCashMovementSchema,
    expenseCategorySchema,
    listCashMovementsQuerySchema,
    listCashSessionsQuerySchema,
    reviewAdjustmentSchema,
} from '../src/schemas/sales';

/**
 * Reglas del movimiento de caja y de la auditoría de cortes. Todo es validación
 * pura del schema: no toca Firestore ni el emulador.
 *
 * El gasto es el caso delicado: sin categoría el módulo de gastos no puede
 * sumar nada por rubro, y en los rubros abiertos (insumos, proveedor, otro) el
 * motivo corto no alcanza para saber en qué se fue el dinero, así que ahí la
 * descripción también es obligatoria.
 */

const gasto = (overrides: Record<string, unknown> = {}) =>
    createCashMovementSchema.safeParse({
        type: 'expense',
        amount: 250,
        reason: 'Pago de garrafones',
        ...overrides,
    });

const CATEGORIAS_CON_DESCRIPCION = ['supplies', 'supplier', 'other'] as const;
const CATEGORIAS_SIN_DESCRIPCION = [
    'salary',
    'food',
    'rent',
    'contingency',
    'electricity',
] as const;

describe('expenseCategorySchema', () => {
    it('cubre exactamente los ocho rubros del módulo de gastos', () => {
        expect([...expenseCategorySchema.options].sort()).toEqual([
            'contingency',
            'electricity',
            'food',
            'other',
            'rent',
            'salary',
            'supplier',
            'supplies',
        ]);
    });

    it('rechaza un rubro inventado', () => {
        expect(expenseCategorySchema.safeParse('viaticos').success).toBe(false);
    });
});

describe('createCashMovementSchema - categoría del gasto', () => {
    it('exige categoría: un gasto sin rubro no se puede reportar', () => {
        expect(gasto().success).toBe(false);
    });

    it('marca el error en el campo `category`, no en la raíz', () => {
        const result = gasto();
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].path).toEqual(['category']);
        }
    });

    it('acepta un gasto con un rubro válido', () => {
        expect(gasto({ category: 'rent' }).success).toBe(true);
    });

    it('rechaza un rubro que no existe', () => {
        expect(gasto({ category: 'viaticos' }).success).toBe(false);
    });

    it('depósitos y retiros no llevan categoría', () => {
        const deposito = createCashMovementSchema.safeParse({
            type: 'deposit',
            amount: 500,
            reason: 'Fondo adicional',
        });
        const retiro = createCashMovementSchema.safeParse({
            type: 'withdrawal',
            amount: 500,
            reason: 'Traslado a bóveda',
        });
        expect(deposito.success).toBe(true);
        expect(retiro.success).toBe(true);
    });

    it('rechaza un tipo de movimiento desconocido', () => {
        const result = createCashMovementSchema.safeParse({
            type: 'transfer',
            amount: 10,
            reason: 'x',
        });
        expect(result.success).toBe(false);
    });
});

describe('createCashMovementSchema - descripción del gasto', () => {
    it.each(CATEGORIAS_CON_DESCRIPCION)(
        'exige descripción en el rubro abierto "%s"',
        (category) => {
            expect(gasto({ category }).success).toBe(false);
        },
    );

    it.each(CATEGORIAS_CON_DESCRIPCION)(
        'acepta el rubro "%s" cuando sí explica en qué se gastó',
        (category) => {
            expect(gasto({ category, description: 'Garrafones de 20L' }).success).toBe(true);
        },
    );

    it('una descripción en blanco no cuenta como explicación', () => {
        expect(gasto({ category: 'other', description: '   ' }).success).toBe(false);
    });

    it('marca el error en el campo `description`', () => {
        const result = gasto({ category: 'supplier' });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].path).toEqual(['description']);
        }
    });

    it.each(CATEGORIAS_SIN_DESCRIPCION)(
        'el rubro fijo "%s" se basta con el motivo',
        (category) => {
            expect(gasto({ category }).success).toBe(true);
        },
    );

    it.each(CATEGORIAS_SIN_DESCRIPCION)(
        'el rubro fijo "%s" igual admite descripción si el cajero la escribe',
        (category) => {
            expect(gasto({ category, description: 'Quincena de agosto' }).success).toBe(true);
        },
    );
});

describe('createCashMovementSchema - monto y motivo', () => {
    it('el monto es positivo: cero o negativo no mueven caja', () => {
        expect(gasto({ category: 'rent', amount: 0 }).success).toBe(false);
        expect(gasto({ category: 'rent', amount: -100 }).success).toBe(false);
    });

    it('el monto lleva dos decimales como máximo', () => {
        expect(gasto({ category: 'rent', amount: 12.34 }).success).toBe(true);
        expect(gasto({ category: 'rent', amount: 12.345 }).success).toBe(false);
    });

    it('exige motivo: sin él el movimiento no explica nada', () => {
        expect(gasto({ category: 'rent', reason: '' }).success).toBe(false);
        expect(gasto({ category: 'rent', reason: '   ' }).success).toBe(false);
    });

    it('el motivo llega hasta 200 caracteres', () => {
        expect(gasto({ category: 'rent', reason: 'a'.repeat(200) }).success).toBe(true);
        expect(gasto({ category: 'rent', reason: 'a'.repeat(201) }).success).toBe(false);
    });

    it('la descripción llega hasta 300 caracteres', () => {
        expect(gasto({ category: 'other', description: 'b'.repeat(300) }).success).toBe(true);
        expect(gasto({ category: 'other', description: 'b'.repeat(301) }).success).toBe(false);
    });

    it('recorta los espacios de motivo y descripción antes de guardarlos', () => {
        const result = createCashMovementSchema.parse({
            type: 'expense',
            amount: 10,
            reason: '  Renta del local  ',
            category: 'other',
            description: '  Local de la esquina  ',
        });
        expect(result.reason).toBe('Renta del local');
        expect(result.description).toBe('Local de la esquina');
    });
});

describe('reviewAdjustmentSchema', () => {
    it('acepta las dos únicas decisiones posibles', () => {
        expect(reviewAdjustmentSchema.safeParse({ decision: 'approved' }).success).toBe(true);
        expect(reviewAdjustmentSchema.safeParse({ decision: 'rejected' }).success).toBe(true);
    });

    it('rechaza una decisión que no lo es', () => {
        expect(reviewAdjustmentSchema.safeParse({ decision: 'pending' }).success).toBe(false);
        expect(reviewAdjustmentSchema.safeParse({}).success).toBe(false);
    });

    it('la nota es opcional y llega hasta 300 caracteres', () => {
        expect(
            reviewAdjustmentSchema.safeParse({ decision: 'approved', note: 'c'.repeat(300) })
                .success,
        ).toBe(true);
        expect(
            reviewAdjustmentSchema.safeParse({ decision: 'approved', note: 'c'.repeat(301) })
                .success,
        ).toBe(false);
    });
});

describe('closeCashSessionSchema', () => {
    it('acepta el cierre normal, con solo el efectivo contado', () => {
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: 1500.5 }).success).toBe(true);
    });

    it('acepta la marca de cierre automático por expiración', () => {
        const result = closeCashSessionSchema.safeParse({
            countedCashAmount: 0,
            autoClosedByExpiry: true,
        });
        expect(result.success).toBe(true);
    });

    it('rechaza un efectivo contado negativo o con más de dos decimales', () => {
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: -1 }).success).toBe(false);
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: 1.234 }).success).toBe(false);
    });
});

describe('listCashSessionsQuerySchema', () => {
    it('acepta la consulta sin filtros', () => {
        expect(listCashSessionsQuerySchema.safeParse({}).success).toBe(true);
    });

    it('acepta rango de fechas, cajero y estado del ajuste', () => {
        const result = listCashSessionsQuerySchema.safeParse({
            from: '2026-09-01T00:00:00.000Z',
            to: '2026-09-30T23:59:59.000Z',
            openedBy: 'u1',
            adjustmentStatus: 'pending',
            page: '2',
            limit: '50',
        });
        expect(result.success).toBe(true);
    });

    it('exige fechas ISO reales', () => {
        expect(listCashSessionsQuerySchema.safeParse({ from: '2026-09-01' }).success).toBe(false);
    });

    it('rechaza un estado de ajuste inventado', () => {
        expect(
            listCashSessionsQuerySchema.safeParse({ adjustmentStatus: 'revisado' }).success,
        ).toBe(false);
    });
});

describe('listCashMovementsQuerySchema', () => {
    it('acepta la consulta sin filtros', () => {
        expect(listCashMovementsQuerySchema.safeParse({}).success).toBe(true);
    });

    it('acepta filtrar por tipo, rubro y turno', () => {
        const result = listCashMovementsQuerySchema.safeParse({
            from: '2026-09-01T00:00:00.000Z',
            to: '2026-09-30T23:59:59.000Z',
            type: 'expense',
            category: 'supplies',
            cashSessionId: 's1',
        });
        expect(result.success).toBe(true);
    });

    it('rechaza un tipo o un rubro que no existen', () => {
        expect(listCashMovementsQuerySchema.safeParse({ type: 'refund' }).success).toBe(false);
        expect(listCashMovementsQuerySchema.safeParse({ category: 'viaticos' }).success)
            .toBe(false);
    });
});
