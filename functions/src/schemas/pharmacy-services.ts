import { z } from 'zod';
import { paginationFields, parseableDate, positiveMoney } from './common';
import { MAX_IEPS_RATE } from '../constants/taxes';

/**
 * Servicios de la farmacia (consultas, procedimientos, otros) y el padrón de
 * quienes los realizan.
 *
 * Dos diferencias deliberadas con el catálogo de productos:
 *
 * 1. El régimen de IVA es **un solo valor** (`taxMode`) y no dos banderas
 *    (`hasIva`/`hasIvaZero`), que en productos pueden contradecirse y obligan a
 *    un `.refine` para impedirlo.
 * 2. No hay `stock`, `minStock`, `controlledGroup` ni `costPrice`: un servicio
 *    no se recibe en una entrada de inventario ni se agota.
 */

/** Naturaleza del servicio; fija el corte al que pertenece. */
export const serviceTypeSchema = z.enum(['consultation', 'procedure', 'other']);

/**
 * Exento (consulta médica: sin IVA y sin acreditamiento), tasa 0% o tasa
 * general 16%. Sin valor por defecto: elegirlo mal cambia lo que se le declara
 * al SAT, así que el alta lo exige.
 */
export const serviceTaxModeSchema = z.enum(['exempt', 'zero', 'iva16']);

/** Tasa de IEPS como fracción (0.08 = 8%), no como porcentaje —igual que en productos. */
const iepsRateSchema = z
    .number()
    .positive('La tasa de IEPS debe ser mayor a cero')
    .max(MAX_IEPS_RATE, `La tasa de IEPS no puede exceder ${MAX_IEPS_RATE}`);

/**
 * Comisión en **porcentaje** (0..100), no en fracción: es lo que se captura en
 * pantalla ("30%") y lo que se lee en el corte del doctor. 0 = sin comisión, que
 * es válido y distinto de "no configurado".
 */
const commissionRateSchema = z
    .number()
    .finite()
    .min(0, 'La comisión no puede ser negativa')
    .max(100, 'La comisión no puede exceder 100%');

/** Cédula profesional mexicana: 7 u 8 dígitos, la misma regla que usa la receta. */
const licenseSchema = z
    .string()
    .trim()
    .regex(/^\d{7,8}$/, 'La cédula profesional debe tener 7 u 8 dígitos');

const serviceCode = z.string().trim()
    .min(1, 'La clave es obligatoria')
    .max(40, 'La clave no puede superar 40 caracteres');
const serviceName = z.string().trim()
    .min(1, 'El nombre es obligatorio')
    .max(120, 'El nombre no puede superar 120 caracteres');
const serviceDescription = z.string().trim()
    .max(300, 'La descripción no puede superar 300 caracteres');

/**
 * `hasIeps` y `iepsRate` van juntos, misma regla que en productos: un servicio
 * con IEPS y sin tasa produciría un desglose fiscal inventado, y una tasa sin
 * `hasIeps` nunca se aplicaría.
 */
const assertIepsRate = (
    data: { hasIeps?: boolean; iepsRate?: number },
    ctx: z.RefinementCtx,
): void => {
    if (data.hasIeps && data.iepsRate === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Un servicio con IEPS requiere la tasa (iepsRate)',
            path: ['iepsRate'],
        });
    }
    if (!data.hasIeps && data.iepsRate !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Solo un servicio con hasIeps puede tener iepsRate',
            path: ['iepsRate'],
        });
    }
};

export const createPharmacyServiceSchema = z
    .object({
        code: serviceCode,
        name: serviceName,
        description: serviceDescription.optional(),
        serviceType: serviceTypeSchema,
        /** Impuesto **incluido**, mismo criterio que `products.salePrice`. */
        price: positiveMoney,
        taxMode: serviceTaxModeSchema,
        hasIeps: z.boolean(),
        iepsRate: iepsRateSchema.optional(),
        commissionRate: commissionRateSchema,
        requiresPerformer: z.boolean(),
    })
    .superRefine((data, ctx) => assertIepsRate(data, ctx));

export const updatePharmacyServiceSchema = z
    .object({
        code: serviceCode.optional(),
        name: serviceName.optional(),
        description: serviceDescription.optional(),
        serviceType: serviceTypeSchema.optional(),
        price: positiveMoney.optional(),
        taxMode: serviceTaxModeSchema.optional(),
        hasIeps: z.boolean().optional(),
        iepsRate: iepsRateSchema.optional(),
        commissionRate: commissionRateSchema.optional(),
        requiresPerformer: z.boolean().optional(),
        isActive: z.boolean().optional(),
    })
    .superRefine((data, ctx) => {
        // En update `hasIeps` puede no venir: solo se valida si el request lo toca.
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

export const listPharmacyServicesQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    serviceType: serviceTypeSchema.optional(),
    ...paginationFields,
});

/** Sin `page`/`limit`: el pull local-first del POS trae todo en una sola llamada. */
export const syncPharmacyServicesQuerySchema = z.object({
    updatedSince: parseableDate.optional(),
});

const providerName = z.string().trim()
    .min(1, 'El nombre es obligatorio')
    .max(120, 'El nombre no puede superar 120 caracteres');

export const createServiceProviderSchema = z.object({
    name: providerName,
    license: licenseSchema.optional(),
    /** El servicio manda; esto solo aplica cuando el servicio no define su tasa. */
    defaultCommissionRate: commissionRateSchema.optional(),
});

export const updateServiceProviderSchema = z.object({
    name: providerName.optional(),
    license: licenseSchema.optional(),
    defaultCommissionRate: commissionRateSchema.optional(),
    isActive: z.boolean().optional(),
});

export const listServiceProvidersQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const syncServiceProvidersQuerySchema = z.object({
    updatedSince: parseableDate.optional(),
});
