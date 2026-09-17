import { z } from 'zod';

import { EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION } from '../constants/expenses';
import { MAX_BACKDATE_DAYS } from '../repositories/cash-movements.repository';
import { isoDate, money, paginationFields, positiveMoney, signedMoney } from './common';
import { expenseCategorySchema } from './sales';

/**
 * Periodo del estado de resultados. `from` y `to` son **obligatorios**, a
 * diferencia de los reportes de gestión: una utilidad "de los últimos 30 días
 * por defecto" no es un estado de resultados de nada, y el encabezado del
 * informe tiene que poder decir a qué periodo corresponde la cifra.
 */
export const incomeStatementQuerySchema = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    /**
     * Agrega el mismo cálculo sobre el periodo inmediatamente anterior, de la
     * misma duración. Cuesta una segunda pasada completa sobre las ventas, así
     * que se pide explícitamente en vez de venir siempre.
     */
    compare: z.enum(['true', 'false']).optional(),
}).refine(
    (data) => new Date(data.from) < new Date(data.to),
    { message: 'El inicio del periodo debe ser anterior al fin', path: ['from'] },
);

/** Cómo se pagó el gasto; solo `cash` sale del cajón. */
export const expensePaymentMethodSchema = z.enum(['cash', 'transfer', 'card']);

const backdateLimit = (): Date =>
    new Date(Date.now() - MAX_BACKDATE_DAYS * 24 * 60 * 60 * 1000);

/**
 * Fecha a la que pertenece el gasto. Acotada por los dos lados:
 *
 * - **Sin futuro**: un gasto que todavía no ocurre no es gasto del periodo; si
 *   se permitiera, el estado de resultados del mes ya cerrado podría cambiar
 *   después de haberse leído.
 * - **Hasta `MAX_BACKDATE_DAYS` atrás**: es el colchón con el que `listForPeriod`
 *   ensancha su lectura. Un gasto fechado más atrás quedaría guardado y aun así
 *   invisible para su propio estado de resultados, que es peor que rechazarlo.
 */
const occurredAtSchema = z
    .string()
    .datetime()
    .refine((value) => new Date(value) <= new Date(), {
        message: 'La fecha del gasto no puede estar en el futuro',
    })
    .refine((value) => new Date(value) >= backdateLimit(), {
        message: `La fecha del gasto no puede ser de más de ${MAX_BACKDATE_DAYS} días atrás`,
    });

/**
 * Gasto capturado desde contabilidad: nómina, renta o luz que se pagaron por
 * transferencia y nunca pasaron por una caja.
 *
 * Nace siempre con `cashSessionId: null` —no hay turno al cual colgarlo— y por
 * eso no altera ningún corte. `paymentMethod` es obligatorio aquí, al revés que
 * en el POS: el punto de esta pantalla es registrar lo que **no** salió del
 * cajón, así que dejarlo implícito en `cash` invitaría justo al error que este
 * módulo existe para evitar.
 */
export const createAccountingExpenseSchema = z.object({
    amount: positiveMoney,
    reason: z.string().trim().min(1).max(200),
    category: expenseCategorySchema,
    description: z.string().trim().max(300).optional(),
    paymentMethod: expensePaymentMethodSchema,
    /**
     * Cuenta de la que salió el dinero. Solo tiene sentido si no fue en
     * efectivo; es lo que permite que el saldo bancario baje sin escribir el
     * mismo gasto en una segunda colección.
     */
    bankAccountId: z.string().min(1).optional(),
    /** Ausente = hoy. */
    occurredAt: occurredAtSchema.optional(),
}).refine(
    (data) => !EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(data.category) ||
        !!data.description?.trim(),
    { message: 'La descripción es requerida para esta categoría', path: ['description'] },
);

/**
 * Corrección de un gasto de contabilidad. Igual que `updateExpenseSchema` del
 * POS: se corrige la cifra, no se reescribe el rastro —`type`, `cashSessionId`,
 * `createdBy` y `createdAt` quedan fuera a propósito.
 */
export const updateAccountingExpenseSchema = z.object({
    amount: positiveMoney.optional(),
    reason: z.string().trim().min(1).max(200).optional(),
    category: expenseCategorySchema.optional(),
    description: z.string().trim().max(300).optional(),
    paymentMethod: expensePaymentMethodSchema.optional(),
    occurredAt: occurredAtSchema.optional(),
}).refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    { message: 'No hay nada que corregir' },
);

export const listAccountingExpensesQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    category: expenseCategorySchema.optional(),
    paymentMethod: expensePaymentMethodSchema.optional(),
    /**
     * `outside` = solo lo capturado en contabilidad (sin turno); `cashbox` =
     * solo lo que salió del cajón de una caja. Sin el filtro salen los dos, que
     * es lo que el estado de resultados suma.
     */
    origin: z.enum(['outside', 'cashbox']).optional(),
    ...paginationFields,
});

/* -------------------------------------------------------------------------- */
/*  Activo fijo, capital y configuración                                      */
/* -------------------------------------------------------------------------- */

export const fixedAssetCategorySchema = z.enum([
    'furniture',
    'equipment',
    'computing',
    'vehicle',
    'improvements',
    'other',
]);

/**
 * Alta de un bien de activo fijo.
 *
 * `usefulLifeMonths` es obligatorio y mayor a cero: sin vida útil no hay
 * depreciación que calcular, y un bien que no se deprecia infla el activo mes a
 * mes sin que nada lo baje.
 */
export const createFixedAssetSchema = z.object({
    name: z.string().trim().min(1).max(120),
    category: fixedAssetCategorySchema,
    acquiredAt: isoDate.refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        { message: 'La fecha de adquisición no puede estar en el futuro' },
    ),
    cost: positiveMoney,
    usefulLifeMonths: z.number().int().positive().max(1200),
    salvageValue: money.default(0),
    notes: z.string().trim().max(300).optional(),
}).refine(
    (data) => data.salvageValue < data.cost,
    {
        // Con rescate igual o mayor al costo la base depreciable sale cero o
        // negativa: el bien nunca se depreciaría, o peor, se apreciaría.
        message: 'El valor de rescate debe ser menor al costo',
        path: ['salvageValue'],
    },
);

export const updateFixedAssetSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    category: fixedAssetCategorySchema.optional(),
    cost: positiveMoney.optional(),
    usefulLifeMonths: z.number().int().positive().max(1200).optional(),
    salvageValue: money.optional(),
    notes: z.string().trim().max(300).nullable().optional(),
}).refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    { message: 'No hay nada que corregir' },
);

/** Baja del bien: deja de depreciarse desde esta fecha. */
export const disposeFixedAssetSchema = z.object({
    disposedAt: isoDate.refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        { message: 'La fecha de baja no puede estar en el futuro' },
    ),
    /** Lo que se recuperó al venderlo o desecharlo; 0 si no se recuperó nada. */
    disposalAmount: money.default(0),
    reason: z.string().trim().min(1).max(300),
});

export const createEquityMovementSchema = z.object({
    type: z.enum(['contribution', 'withdrawal']),
    amount: positiveMoney,
    occurredAt: isoDate.refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        { message: 'La fecha no puede estar en el futuro' },
    ),
    partner: z.string().trim().min(1).max(120),
    note: z.string().trim().max(300).optional(),
});

export const equityQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
});

/**
 * Saldos de apertura. Todos opcionales porque la pantalla guarda por partes,
 * pero ninguno puede ser negativo: un pasivo o una depreciación se capturan en
 * positivo en su propio rubro, y aceptar negativos permitiría cuadrar el balance
 * a base de signos en vez de a base de cifras.
 */
export const openingBalancesSchema = z.object({
    cash: money.optional(),
    bank: money.optional(),
    inventory: money.optional(),
    payables: money.optional(),
    fixedAssets: money.optional(),
    accumulatedDepreciation: money.optional(),
    equityContributions: money.optional(),
    retainedEarnings: money.optional(),
});

export const updateAccountingSettingsSchema = z.object({
    startDate: isoDate.nullable().optional(),
    openingBalances: openingBalancesSchema.optional(),
}).refine(
    (data) => data.startDate !== undefined || data.openingBalances !== undefined,
    { message: 'No hay nada que guardar' },
);

/**
 * Cierre de periodo. `through: null` reabre todo —es la única forma de deshacer
 * un cierre hecho por error, y queda auditada como cualquier otro cambio.
 */
export const closePeriodSchema = z.object({
    through: isoDate.nullable(),
});

export const balanceSheetQuerySchema = z.object({
    /** Ausente = hoy. El inventario solo puede valuarse a hoy; ver el servicio. */
    asOf: z.string().datetime().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Bancos                                                                    */
/* -------------------------------------------------------------------------- */

/** Solo los últimos cuatro dígitos: el número completo no se guarda. */
const last4Schema = z.string().trim().regex(/^\d{4}$/, 'Deben ser 4 dígitos');

export const createBankAccountSchema = z.object({
    name: z.string().trim().min(1).max(80),
    bank: z.string().trim().min(1).max(60),
    last4: last4Schema.optional(),
    /**
     * Saldo inicial **con signo**: una cuenta puede arrancar sobregirada, y
     * recortarla a cero no hace aparecer el dinero —solo mueve el descuadre al
     * balance, donde ya nadie sabe de dónde salió.
     */
    openingBalance: signedMoney,
    openingDate: isoDate,
});

export const updateBankAccountSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    bank: z.string().trim().min(1).max(60).optional(),
    last4: last4Schema.nullable().optional(),
    openingBalance: signedMoney.optional(),
    openingDate: isoDate.optional(),
    isActive: z.boolean().optional(),
}).refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    { message: 'No hay nada que actualizar' },
);

const pastIsoDate = isoDate.refine(
    (value) => value <= new Date().toISOString().slice(0, 10),
    { message: 'La fecha no puede estar en el futuro' },
);

export const createBankMovementSchema = z.object({
    accountId: z.string().min(1),
    direction: z.enum(['in', 'out']),
    amount: positiveMoney,
    occurredAt: pastIsoDate,
    concept: z.string().trim().min(1).max(200),
    reference: z.string().trim().max(120).optional(),
});

/**
 * Traspaso entre caja y banco. `direction` dice a dónde va el dinero, no de
 * dónde sale: `toBank` baja el efectivo del cajón y sube el saldo de la cuenta.
 */
export const createBankTransferSchema = z.object({
    accountId: z.string().min(1),
    direction: z.enum(['toBank', 'toCash']),
    amount: positiveMoney,
    occurredAt: pastIsoDate,
    concept: z.string().trim().min(1).max(200),
    reference: z.string().trim().max(120).optional(),
});

export const reconcileMovementSchema = z.object({
    reconciled: z.boolean(),
});

export const bankMovementsQuerySchema = z.object({
    accountId: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
});

export const reconciliationQuerySchema = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    accountId: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Gastos devengados                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Alta de un gasto causado y aún no pagado.
 *
 * `accruedAt` es la fecha de **devengo** —a qué mes pertenece el gasto—, no la
 * de captura ni la de pago. Es lo que hace que la renta de marzo pegue en marzo
 * aunque se liquide en abril.
 */
export const createAccruedExpenseSchema = z.object({
    category: expenseCategorySchema,
    concept: z.string().trim().min(1).max(200),
    description: z.string().trim().max(300).optional(),
    amount: positiveMoney,
    accruedAt: isoDate.refine(
        (value) => value <= new Date().toISOString().slice(0, 10),
        { message: 'La fecha de devengo no puede estar en el futuro' },
    ),
    dueDate: isoDate.optional(),
}).refine(
    (data) => data.dueDate === undefined || data.dueDate >= data.accruedAt,
    { message: 'El vencimiento no puede ser anterior al devengo', path: ['dueDate'] },
);

/**
 * Pago de un gasto devengado. No lleva categoría: la trae el gasto, y volver a
 * capturarla permitiría que el pago cayera en una categoría distinta de la que
 * ya pegó en el estado de resultados.
 */
export const payAccruedExpenseSchema = z.object({
    amount: positiveMoney,
    paymentMethod: expensePaymentMethodSchema,
    paidAt: isoDate
        .refine((value) => value <= new Date().toISOString().slice(0, 10), {
            message: 'La fecha del pago no puede estar en el futuro',
        })
        .optional(),
    bankAccountId: z.string().min(1).optional(),
});

export const accruedExpensesQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    onlyPending: z.enum(['true', 'false']).optional(),
});
