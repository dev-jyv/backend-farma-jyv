import { z } from 'zod';
import { paginationFields, parseableDate, positiveMoney } from './common';

/**
 * Cupones de descuento (SPEC 47). `scope`, `discount` y `productIds` son
 * **inmutables**: no hay ruta de edición, solo alta y baja. Para cambiarlos se
 * da de baja y se crea otro con otro código, igual que las promociones.
 */

/** Código normalizado: sin espacios a los lados y en mayúsculas. */
export const COUPON_CODE_PATTERN = /^[A-Z0-9-]{4,20}$/;
const COUPON_CODE_MESSAGE =
    'El código debe tener de 4 a 20 caracteres: letras, números o guiones';

export const normalizeCouponCode = (code: string): string => code.trim().toUpperCase();

export const couponCodeSchema = z
    .string()
    .transform(normalizeCouponCode)
    .pipe(z.string().regex(COUPON_CODE_PATTERN, COUPON_CODE_MESSAGE));

export const couponCodeParamSchema = z.object({ code: couponCodeSchema });

const maxTwoDecimals = (value: number): boolean => Math.round(value * 100) / 100 === value;

const couponDiscountSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('percent'),
        percent: z
            .number()
            .finite()
            .min(1, 'El porcentaje debe ser de al menos 1')
            .max(90, 'El porcentaje no puede superar 90')
            .refine(maxTwoDecimals, { message: 'El porcentaje admite máximo 2 decimales' }),
    }),
    z.object({
        type: z.literal('amount'),
        /** En pesos; en alcance `product` es por pieza. */
        amount: positiveMoney,
    }),
]);

export const createCouponSchema = z
    .object({
        code: couponCodeSchema,
        name: z.string().trim()
            .min(1, 'El nombre es obligatorio')
            .max(120, 'El nombre no puede superar 120 caracteres'),
        scope: z.enum(['product', 'sale']),
        productIds: z
            .array(z.string().min(1))
            .max(50, 'Máximo 50 productos por cupón')
            .refine((ids) => new Set(ids).size === ids.length, {
                message: 'Hay productos repetidos',
            })
            .optional(),
        discount: couponDiscountSchema,
        minPurchase: positiveMoney.nullable().optional(),
        /** Sin fecha, empieza al crearse. */
        startsAt: parseableDate.optional(),
        endsAt: parseableDate.nullable().optional(),
        maxUses: z
            .number()
            .int('Los usos máximos deben ser un número entero')
            .min(1, 'Los usos máximos deben ser al menos 1')
            .max(1_000_000)
            .nullable()
            .optional(),
    })
    .superRefine((data, ctx) => {
        const productCount = data.productIds?.length ?? 0;
        if (data.scope === 'product' && productCount === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Selecciona al menos un producto',
                path: ['productIds'],
            });
        }
        if (data.scope === 'sale' && productCount > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Un cupón de venta no lleva productos',
                path: ['productIds'],
            });
        }
        if (data.scope === 'product' && data.minPurchase !== undefined &&
            data.minPurchase !== null) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'La compra mínima solo aplica a cupones de venta',
                path: ['minPurchase'],
            });
        }
        if (data.startsAt && data.endsAt &&
            Date.parse(data.endsAt) <= Date.parse(data.startsAt)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'La fecha de fin debe ser posterior a la de inicio',
                path: ['endsAt'],
            });
        }
    });

export const listCouponsQuerySchema = z.object({
    isActive: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

/** Sin `page`/`limit`: el pull local-first del POS trae todo en una sola llamada. */
export const syncCouponsQuerySchema = z.object({
    updatedSince: parseableDate.optional(),
});
