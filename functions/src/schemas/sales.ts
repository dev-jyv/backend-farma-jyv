import { z } from 'zod';
import {
    money,
    paginationFields,
    parseableDate,
    phoneMx,
    positiveMoney,
    qty,
    rfc,
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

export const createSaleSchema = z.object({
    idempotencyKey: nullable(idempotencyKeySchema),
    items: z.array(z.object({
        productId: z.string().min(1),
        quantity: qty,
        discountAmount: money.optional(),
    })).min(1).max(100),
    saleDiscountAmount: money.optional(),
    paymentMethod: z.enum(['cash', 'card', 'transfer', 'mixed']),
    amountReceived: nullable(money),
    cardPaymentReference: nullable(z.string().min(1)),
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
    if (data.paymentMethod === 'card' && !data.cardPaymentReference) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'El pago con tarjeta requiere el id de la order de Mercado Pago Point',
            path: ['cardPaymentReference'],
        });
    }
    if (data.paymentMethod === 'mixed' && !data.cardPaymentReference) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'El pago mixto requiere el id de la order de Mercado Pago Point',
            path: ['cardPaymentReference'],
        });
    }
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
    openingAmount: money,
});

export const closeCashSessionSchema = z.object({
    countedCashAmount: money,
});

export const createCashMovementSchema = z.object({
    type: z.enum(['deposit', 'withdrawal', 'expense']),
    amount: positiveMoney,
    reason: z.string().trim().min(1).max(200),
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
