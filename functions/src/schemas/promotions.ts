import { z } from 'zod';
import { paginationFields, parseableDate, positiveMoney } from './common';

/**
 * Promociones por cantidad. La regla (`rule`) y los productos son **inmutables**
 * una vez creada la promoción: el update no los acepta. Para cambiar un precio
 * se da de baja y se crea otra, así una venta offline cobrada con la regla vieja
 * sigue validando al sincronizar.
 */

const MAX_BUNDLE_QTY = 100;

const bundleQty = z
    .number()
    .int('La cantidad debe ser un número entero')
    .min(2, 'Un paquete debe tener al menos 2 piezas')
    .max(MAX_BUNDLE_QTY, `Un paquete no puede superar ${MAX_BUNDLE_QTY} piezas`);

const tieredRuleSchema = z.object({
    type: z.literal('tiered'),
    tiers: z
        .array(z.object({ quantity: bundleQty, price: positiveMoney }))
        .min(1, 'Agrega al menos un escalón')
        .max(10, 'Máximo 10 escalones'),
});

const nxmRuleSchema = z.object({
    type: z.literal('nxm'),
    buy: bundleQty,
    pay: z.number().int().min(1, 'Debe pagarse al menos una pieza'),
});

const percentRuleSchema = z.object({
    type: z.literal('percent'),
    percent: z
        .number()
        .finite()
        .gt(0, 'El porcentaje debe ser mayor a 0')
        .lt(100, 'El porcentaje debe ser menor a 100'),
    minQty: z.number().int().min(1).max(MAX_BUNDLE_QTY),
});

/**
 * Las reglas cruzadas van en un `superRefine` sobre la unión y no en cada
 * rama: `discriminatedUnion` exige objetos planos, no `ZodEffects`.
 */
export const promotionRuleSchema = z
    .discriminatedUnion('type', [tieredRuleSchema, nxmRuleSchema, percentRuleSchema])
    .superRefine((rule, ctx) => {
        if (rule.type === 'nxm' && rule.pay >= rule.buy) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Las piezas pagadas deben ser menos que las que se llevan',
                path: ['pay'],
            });
        }
        if (rule.type !== 'tiered') {
            return;
        }
        const sorted = [...rule.tiers].sort((a, b) => a.quantity - b.quantity);
        for (let i = 1; i < sorted.length; i += 1) {
            if (sorted[i].quantity === sorted[i - 1].quantity) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'No puede haber dos escalones con la misma cantidad',
                    path: ['tiers'],
                });
                return;
            }
            // Precio por pieza que sube con la cantidad es casi siempre un error
            // de captura (60 por 2, 100 por 3): el paquete grande nunca conviene.
            if (sorted[i].price / sorted[i].quantity >
                sorted[i - 1].price / sorted[i - 1].quantity) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'El precio por pieza debe bajar al subir la cantidad',
                    path: ['tiers'],
                });
                return;
            }
        }
    });

const promotionName = z.string().trim()
    .min(1, 'El nombre es obligatorio')
    .max(120, 'El nombre no puede superar 120 caracteres');
const promotionDescription = z.string().trim()
    .max(300, 'La descripción no puede superar 300 caracteres');

const assertWindow = (
    data: { startsAt?: string; endsAt?: string | null },
    ctx: z.RefinementCtx,
): void => {
    if (data.startsAt && data.endsAt && Date.parse(data.endsAt) <= Date.parse(data.startsAt)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'La fecha de fin debe ser posterior a la de inicio',
            path: ['endsAt'],
        });
    }
};

export const createPromotionSchema = z
    .object({
        name: promotionName,
        description: promotionDescription.optional(),
        rule: promotionRuleSchema,
        productIds: z
            .array(z.string().min(1))
            .min(1, 'Selecciona al menos un producto')
            .max(50, 'Máximo 50 productos por promoción')
            .refine((ids) => new Set(ids).size === ids.length, {
                message: 'Hay productos repetidos',
            }),
        /** Sin fecha, empieza al crearse. */
        startsAt: parseableDate.optional(),
        endsAt: parseableDate.nullable().optional(),
    })
    .superRefine((data, ctx) => assertWindow(data, ctx));

/** `.strict()`: mandar `rule` o `productIds` es un 400, no un cambio ignorado. */
export const updatePromotionSchema = z
    .object({
        name: promotionName.optional(),
        description: promotionDescription.optional(),
        startsAt: parseableDate.optional(),
        endsAt: parseableDate.nullable().optional(),
        isActive: z.boolean().optional(),
    })
    .strict()
    .superRefine((data, ctx) => assertWindow(data, ctx));

export const listPromotionsQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

/** Sin `page`/`limit`: el pull local-first del POS trae todo en una sola llamada. */
export const syncPromotionsQuerySchema = z.object({
    updatedSince: parseableDate.optional(),
});

/**
 * Horizonte de las sugerencias por caducidad. Tope de 180 días: más allá no es
 * mercancía por caducar, es inventario normal, y rematarla regala margen.
 */
export const expiringSuggestionsQuerySchema = z.object({
    days: z.coerce
        .number()
        .int('Los días deben ser un número entero')
        .min(1, 'Mínimo 1 día')
        .max(180, 'Máximo 180 días')
        .default(90),
});
