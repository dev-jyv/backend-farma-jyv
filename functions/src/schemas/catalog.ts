import { z } from 'zod';
import { money, paginationFields, phoneMx } from './common';
import { MAX_IEPS_RATE } from '../constants/taxes';
import { CONTROLLED_GROUPS } from '../constants/controlled';

export const listCategoriesQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const createCategorySchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).optional(),
});

export const updateCategorySchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).optional(),
    isActive: z.boolean().optional(),
});

const barcodeSchema = z
    .string()
    .trim()
    .regex(/^\d{8,14}$/, 'El código de barras debe tener entre 8 y 14 dígitos');

/** Grupo COFEPRIS del producto (art. 226 LGS). */
const controlledGroupSchema = z.enum(
    CONTROLLED_GROUPS as [string, ...string[]],
) as z.ZodType<typeof CONTROLLED_GROUPS[number]>;

/** Tasa de IEPS como fracción (0.08 = 8%), no como porcentaje. */
const iepsRateSchema = z
    .number()
    .positive('La tasa de IEPS debe ser mayor a cero')
    .max(MAX_IEPS_RATE, `La tasa de IEPS no puede exceder ${MAX_IEPS_RATE}`);

/**
 * `hasIeps` y `iepsRate` van juntos: un producto con IEPS y sin tasa produciría
 * un desglose fiscal inventado, y una tasa sin `hasIeps` nunca se aplicaría.
 */
const assertIepsRate = (
    data: { hasIeps?: boolean; iepsRate?: number },
    ctx: z.RefinementCtx,
): void => {
    if (data.hasIeps && data.iepsRate === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Un producto con IEPS requiere la tasa (iepsRate)',
            path: ['iepsRate'],
        });
    }
    if (!data.hasIeps && data.iepsRate !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Solo un producto con hasIeps puede tener iepsRate',
            path: ['iepsRate'],
        });
    }
};

export const createProductSchema = z
    .object({
        name: z.string().trim().min(1).max(120),
        sku: z.string().trim().min(1).max(40),
        barcode: barcodeSchema.optional(),
        activeIngredient: z.string().trim().max(120).optional(),
        categoryId: z.string().min(1),
        unit: z.string().trim().min(1).max(30),
        salePrice: money,
        minStock: z.number().int().nonnegative(),
        hasIva: z.boolean(),
        hasIvaZero: z.boolean(),
        hasIeps: z.boolean(),
        iepsRate: iepsRateSchema.optional(),
        controlledGroup: controlledGroupSchema.optional(),
        concentration: z.string().trim().max(80).optional(),
        requiresPrescription: z.boolean().optional(),
    })
    .refine((data) => !(data.hasIva && data.hasIvaZero), {
        message: 'Un producto no puede tener IVA e IVA cero al mismo tiempo',
        path: ['hasIvaZero'],
    })
    .superRefine((data, ctx) => assertIepsRate(data, ctx));

export const updateProductSchema = z
    .object({
        name: z.string().trim().min(1).max(120).optional(),
        sku: z.string().trim().min(1).max(40).optional(),
        barcode: barcodeSchema.optional(),
        activeIngredient: z.string().trim().max(120).optional(),
        categoryId: z.string().min(1).optional(),
        unit: z.string().trim().min(1).max(30).optional(),
        salePrice: money.optional(),
        minStock: z.number().int().nonnegative().optional(),
        hasIva: z.boolean().optional(),
        hasIvaZero: z.boolean().optional(),
        hasIeps: z.boolean().optional(),
        iepsRate: iepsRateSchema.optional(),
        controlledGroup: controlledGroupSchema.optional(),
        concentration: z.string().trim().max(80).optional(),
        requiresPrescription: z.boolean().optional(),
        isActive: z.boolean().optional(),
    })
    .refine((data) => !(data.hasIva === true && data.hasIvaZero === true), {
        message: 'Un producto no puede tener IVA e IVA cero al mismo tiempo',
        path: ['hasIvaZero'],
    })
    .superRefine((data, ctx) => {
        // En update, `hasIeps` puede no venir: solo se valida si el request lo toca.
        if (data.hasIeps === undefined) {
            if (data.iepsRate !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Envía hasIeps junto con iepsRate',
                    path: ['hasIeps'],
                });
            }
            return;
        }
        assertIepsRate({ hasIeps: data.hasIeps, iepsRate: data.iepsRate }, ctx);
    });

export const bulkCreateProductsSchema = z.object({
    items: z.array(createProductSchema).min(1).max(500),
});

export const updateProductPriceItemSchema = z.object({
    productId: z.string().min(1),
    salePrice: money,
});

export const updateProductPricesSchema = z.object({
    items: z.array(updateProductPriceItemSchema).min(1),
});

export const listProductsQuerySchema = z.object({
    categoryId: z.string().optional(),
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const listProductHistoryQuerySchema = z.object({
    ...paginationFields,
});

export const createSupplierSchema = z.object({
    name: z.string().trim().min(1).max(120),
    contactName: z.string().trim().max(120).optional(),
    email: z.string().trim().email().optional(),
    phone: phoneMx.optional(),
    address: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(500).optional(),
});

export const updateSupplierSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    contactName: z.string().trim().max(120).optional(),
    email: z.string().trim().email().optional(),
    phone: phoneMx.optional(),
    address: z.string().trim().max(300).optional(),
    notes: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
});

export const listSuppliersQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});
