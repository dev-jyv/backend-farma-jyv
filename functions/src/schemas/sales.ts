import { z } from 'zod';
import {
    money,
    paginationFields,
    parseableDate,
    phoneMx,
    positiveMoney,
    qty,
    rfc,
    signedMoney,
    usoCfdiSchema,
} from './common';

const nullable = <T extends z.ZodTypeAny>(schema: T) =>
    schema.nullish().transform((value): z.infer<T> | undefined => value ?? undefined);

export const salePrescriptionSchema = z.object({
    doctorName: z.string().trim().min(1).max(120),
    /** Cédula profesional mexicana: 7 u 8 dígitos. */
    doctorLicense: z
        .string()
        .trim()
        .regex(/^\d{7,8}$/, 'La cédula profesional debe tener 7 u 8 dígitos'),
    folio: z.string().trim().min(1).max(40).optional(),
});

export const saleBillingSchema = z.object({
    rfc,
    name: z.string().trim().min(1).max(150),
    usoCfdi: usoCfdiSchema.optional(),
    email: z.string().trim().email().optional(),
});

/**
 * Llave de idempotencia de venta: la genera el cliente (uuid v4 o similar) y la
 * reenvía sin cambios en cada retry del mismo cobro. Ver `idempotencyKey` en
 * `sales.service.ts`.
 */
export const idempotencyKeySchema = z.string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_:-]+$/, 'La llave de idempotencia solo admite [A-Za-z0-9_:-]');

/**
 * Cuerpo **opcional** de la anulación. Solo lo manda el POS cuando cierra una
 * anulación que ocurrió sin red: el instante y el cajero reales son los de
 * entonces, no los del momento en que se logró sincronizar.
 */
export const voidSaleSchema = z.preprocess(
    (value) => value ?? {},
    z.object({
        voidedAt: parseableDate.optional(),
        /**
         * Uid del cajero que anuló en la caja. Se guarda como autor de la
         * anulación, pero **no** sustituye la identidad de la petición: la
         * bitácora de auditoría sigue registrando al usuario del token.
         */
        voidedBy: z.string().min(1).max(128).optional(),
    }),
);

/**
 * Venta cobrada en caja que el backend no pudo registrar (stock, producto,
 * turno). La manda el POS para que el movimiento no se pierda; se guarda en
 * `unreconciledSales`, no en `sales`.
 */
export const createUnreconciledSaleSchema = z.object({
    /** Id de la venta en el SQLite de la caja: liga las dos bases y evita duplicados. */
    localId: z.string().min(1).max(128),
    localFolio: z.string().max(80).optional(),
    reason: z.string().trim().min(1).max(500),
    total: money,
    occurredAt: parseableDate.optional(),
    cashSessionId: z.string().min(1).optional(),
    /** `CreateSalePayload` tal como se intentó registrar; se guarda íntegro. */
    payload: z.record(z.string(), z.unknown()),
});

export const listUnreconciledSalesQuerySchema = z.object({
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    includeResolved: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

const saleProductItemSchema = z.object({
    kind: z.literal('product'),
    productId: z.string().min(1),
    quantity: qty,
    discountAmount: money.optional(),
    /**
     * Precio cobrado por unidad. Lo manda el POS para que una venta sin conexión
     * se registre con el precio del momento y no con el de catálogo al
     * sincronizar. Ausente en clientes viejos: entonces manda el catálogo.
     */
    unitPrice: positiveMoney.optional(),
});

const saleServiceItemSchema = z.object({
    kind: z.literal('service'),
    serviceId: z.string().min(1),
    quantity: qty,
    discountAmount: money.optional(),
    /**
     * Precio cobrado por unidad, igual que en las partidas de mercancía. Lo manda
     * el POS para que una consulta cobrada sin conexión se registre con el precio
     * del momento y no con el del catálogo al sincronizar: si el admin subía el
     * precio entre el cobro y el sync, la venta se rechazaba con "el monto
     * recibido es menor al total" y quedaba bloqueada con el dinero ya cobrado.
     * Ausente en clientes viejos: entonces manda el catálogo.
     */
    unitPrice: positiveMoney.optional(),
    /**
     * Doctor al que se le acredita la comisión. Opcional aquí porque solo los
     * servicios con `requiresPerformer` lo exigen, y eso lo sabe el catálogo, no
     * el payload: quien lo valida es `createSale`.
     */
    providerId: nullable(z.string().min(1)),
});

/**
 * Partida de venta: mercancía o servicio, discriminadas por `kind`.
 *
 * El `preprocess` es **compatibilidad, no azúcar**: el POS ya instalado manda
 * partidas sin `kind` y hay ventas encoladas offline con ese formato. Sin `kind`
 * la partida es mercancía, como lo fue siempre.
 */
export const saleLineItemSchema = z.preprocess(
    (value) => {
        if (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            (value as { kind?: unknown }).kind === undefined
        ) {
            return { ...(value as Record<string, unknown>), kind: 'product' };
        }
        return value;
    },
    z.discriminatedUnion('kind', [saleProductItemSchema, saleServiceItemSchema]),
);

export const createSaleSchema = z.object({
    idempotencyKey: nullable(idempotencyKeySchema),
    items: z.array(saleLineItemSchema).min(1).max(100),
    saleDiscountAmount: money.optional(),
    paymentMethod: z.enum(['cash', 'card', 'transfer', 'mixed']),
    amountReceived: nullable(money),
    cardPaymentReference: nullable(z.string().min(1)),
    /**
     * Parte cobrada con tarjeta en pago mixto **sin** terminal Point. Cuando hay
     * order, manda el monto de la order y este campo se ignora: la terminal es la
     * fuente de verdad siempre que exista.
     */
    cardAmount: nullable(money),
    cashSessionId: z.string().min(1),
    customerId: nullable(z.string().min(1)),
    customerName: nullable(z.string().trim().min(1).max(150)),
    prescription: nullable(salePrescriptionSchema),
    /** Confirmación de que la receta se retuvo (obligatorio en grupos I a III). */
    prescriptionRetained: nullable(z.boolean()),
    billing: nullable(saleBillingSchema),
}).superRefine((data, ctx) => {
    if (
        (data.paymentMethod === 'cash' || data.paymentMethod === 'mixed') &&
        data.amountReceived === undefined
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'El monto recibido es requerido para este método de pago',
            path: ['amountReceived'],
        });
    }
    if (
        data.paymentMethod === 'mixed' &&
        data.amountReceived !== undefined &&
        data.amountReceived <= 0
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'El pago mixto requiere el efectivo recibido (mayor a cero)',
            path: ['amountReceived'],
        });
    }
    /**
     * La order de Point **no** es obligatoria: con la terminal desactivada, tarjeta
     * y mixto se registran igual que el efectivo (`resolveTender` lo documenta y lo
     * implementa). Exigirla aquí rechazaba con 400 toda venta con tarjeta hecha sin
     * terminal, y el POS las dejaba atoradas en la cola.
     *
     * Cuando la order sí viene, `resolvePointPayment` la verifica contra Mercado
     * Pago: monto, estado `processed` y que no se haya reutilizado.
     *
     * Lo que el mixto necesita siempre es el **reparto**: sin order que lo diga,
     * tiene que venir `cardAmount`, o no hay forma de saber cuánto entró al cajón.
     */
    if (
        data.paymentMethod === 'mixed' &&
        !data.cardPaymentReference &&
        (data.cardAmount === undefined || data.cardAmount === null)
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
                'El pago mixto requiere el monto cobrado con tarjeta ' +
                '(o la order de Mercado Pago Point)',
            path: ['cardAmount'],
        });
    }
});

/**
 * Empuje del sync local-first del POS: todas las ventas pendientes de una caja
 * en una sola llamada, en vez de un `POST /sales` por venta.
 */
export const bulkCreateSalesSchema = z.object({
    items: z.array(createSaleSchema).min(1).max(200),
});

export const createSaleReturnSchema = z.object({
    idempotencyKey: nullable(idempotencyKeySchema),
    saleId: z.string().min(1),
    items: z.array(z.object({
        productId: z.string().min(1),
        quantity: qty,
    })).min(1).max(100),
    /** Por omisión se reembolsa por el mismo método de la venta. */
    refundMethod: nullable(z.enum(['cash', 'card', 'transfer'])),
    reason: z.string().trim().min(1).max(200),
    cashSessionId: z.string().min(1),
});

export const listSaleReturnsQuerySchema = z.object({
    saleId: z.string().min(1).optional(),
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    cashSessionId: z.string().min(1).optional(),
});

/** Ancho del rollo térmico; 58mm es el estándar de las TPV chicas. */
export const receiptQuerySchema = z.object({
    width: z
        .enum(['58', '80'])
        .optional()
        .transform((value) => (value === '80' ? 80 : 58) as 58 | 80),
});

export const createInventoryCountSchema = z.object({
    items: z.array(z.object({
        batchId: z.string().min(1),
        countedQuantity: z.number().int().nonnegative(),
    })).min(1).max(500),
    notes: z.string().trim().max(300).optional(),
});

export const listInventoryCountsQuerySchema = z.object({
    productId: z.string().min(1).optional(),
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    ...paginationFields,
});

export const inventoryAlertsQuerySchema = z.object({
    /** Ventanas de caducidad en días, separadas por comas (por omisión 30,60,90). */
    windows: z
        .string()
        .regex(/^\d{1,4}(,\d{1,4})*$/, 'Las ventanas deben ser días separados por comas')
        .optional()
        .transform((value) => value?.split(',').map(Number)),
});

export const listControlledLedgerQuerySchema = z.object({
    saleId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    group: z.enum(['I', 'II', 'III', 'IV', 'V', 'VI']).optional(),
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    ...paginationFields,
});

export const exportControlledLedgerQuerySchema = z.object({
    productId: z.string().min(1).optional(),
    group: z.enum(['I', 'II', 'III', 'IV', 'V', 'VI']).optional(),
    from: parseableDate.optional(),
    to: parseableDate.optional(),
});

export const listAuditLogsQuerySchema = z.object({
    action: z.string().min(1).max(60).optional(),
    entity: z
        .enum(['product', 'sale', 'saleReturn', 'cashSession', 'inventoryCount', 'role', 'user'])
        .optional(),
    entityId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    ...paginationFields,
});

export const reportPeriodQuerySchema = z.object({
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * Reporte de comisiones. `providerId` es un id de `serviceProviders` —el doctor
 * del catálogo, que no es usuario del sistema—, no un uid. Cuando viene, el
 * servicio resuelve el periodo con la consulta indexada por `providerIds`.
 */
export const commissionsQuerySchema = z.object({
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    providerId: z.string().min(1).optional(),
});

export const deadStockQuerySchema = z.object({
    days: z.coerce.number().int().positive().max(3650).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
});

export const scanCodeSchema = z.object({
    /** Cadena tal como la entrega el lector (puede traer FNC1 o paréntesis). */
    code: z.string().min(1).max(200),
});

export const listSalesQuerySchema = z.object({
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    cashSessionId: z.string().min(1).optional(),
    includeVoided: z
        .union([z.boolean(), z.enum(['true', 'false'])])
        .optional()
        .transform((value) => {
            if (value === undefined) {
                return undefined;
            }
            return value === true || value === 'true';
        }),
    ...paginationFields,
});

export const openCashSessionSchema = z.object({
    /** Puede ser negativo: hereda el efectivo del corte anterior. Ver `signedMoney`. */
    openingAmount: signedMoney,
});

export const closeCashSessionSchema = z.object({
    /**
     * También puede ser negativo. No es "billetes contados a mano": arrastra el
     * fondo heredado, que ya puede venir en rojo, y una caja puede quedar en
     * números rojos si se gastó de más o si un movimiento se registró mal. Un
     * cierre que no se puede capturar tal cual es un cierre que se falsea.
     */
    countedCashAmount: signedMoney,
    /** El POS lo cerró solo por expiración de sesión (24:00 CDMX), sin cajero presente. */
    autoClosedByExpiry: z.boolean().optional(),
});

/** Categorías del módulo de gastos; solo aplican cuando `type === 'expense'`. */
export const expenseCategorySchema = z.enum([
    'salary', 'food', 'rent', 'contingency', 'electricity', 'supplies', 'supplier', 'other',
]);

/** Categorías que exigen descripción de en qué se gastó (no basta el motivo corto). */
import { EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION } from '../constants/expenses';


export const createCashMovementSchema = z.object({
    type: z.enum(['deposit', 'withdrawal', 'expense']),
    amount: positiveMoney,
    reason: z.string().trim().min(1).max(200),
    category: expenseCategorySchema.optional(),
    description: z.string().trim().max(300).optional(),
}).refine(
    (data) => data.type !== 'expense' || data.category !== undefined,
    { message: 'La categoría es requerida para gastos', path: ['category'] },
).refine(
    (data) => data.category === undefined ||
        !EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(data.category) ||
        !!data.description?.trim(),
    { message: 'La descripción es requerida para esta categoría', path: ['description'] },
);

/**
 * Caja de la farmacia (solo admin): entrada o salida de efectivo que puede ir
 * sin turno. Deliberadamente sin `expense` —los gastos con categoría viven en
 * `createCashMovementSchema`, que sí exige turno— y con `cashSessionId` en el
 * cuerpo en vez del path, porque puede no haber sesión a la cual colgarlo.
 */
export const createCashBoxMovementSchema = z.object({
    type: z.enum(['deposit', 'withdrawal']),
    amount: positiveMoney,
    reason: z.string().trim().min(1).max(200),
    cashSessionId: z.string().trim().min(1).optional(),
});

export const listCashSessionsQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    openedBy: z.string().optional(),
    adjustmentStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
    ...paginationFields,
});

/**
 * Corrección de un gasto ya registrado. Todos los campos son opcionales —es un
 * parche—, pero al menos uno debe venir: un PATCH vacío es una llamada perdida.
 * `type` y `cashSessionId` quedan fuera a propósito: se corrige la cifra, no se
 * reescribe a qué turno pertenece ni qué clase de movimiento es.
 */
export const updateExpenseSchema = z.object({
    amount: positiveMoney.optional(),
    reason: z.string().trim().min(1).max(200).optional(),
    category: expenseCategorySchema.optional(),
    description: z.string().trim().max(300).optional(),
}).refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    { message: 'No hay nada que corregir' },
);

export const listCashMovementsQuerySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    type: z.enum(['deposit', 'withdrawal', 'expense']).optional(),
    category: expenseCategorySchema.optional(),
    cashSessionId: z.string().optional(),
    ...paginationFields,
});

export const reviewAdjustmentSchema = z.object({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().trim().max(300).optional(),
});

export const createCustomerSchema = z.object({
    name: z.string().trim().min(1).max(150),
    rfc: rfc.optional(),
    phone: phoneMx.optional(),
    email: z.string().trim().email().optional(),
});

export const updateCustomerSchema = z.object({
    name: z.string().trim().min(1).max(150).optional(),
    rfc: rfc.optional(),
    phone: phoneMx.optional(),
    email: z.string().trim().email().optional(),
});

export const listCustomersQuerySchema = z.object({
    ...paginationFields,
});
