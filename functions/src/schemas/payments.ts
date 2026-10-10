import { z } from 'zod';
import { positiveMoney } from './common';
import { idempotencyKeySchema } from './sales';

const nullable = <T extends z.ZodTypeAny>(schema: T) =>
    schema.nullish().transform((value): z.infer<T> | undefined => value ?? undefined);

export const listPointDevicesQuerySchema = z.object({
    storeId: z.string().min(1).optional(),
    posId: z.string().min(1).optional(),
});

export const setupPointDeviceSchema = z.object({
    deviceId: z.string().min(1),
    operatingMode: z.enum(['PDV', 'STANDALONE']),
});

export const createPointStoreSchema = z.object({
    name: z.string().min(1).max(60),
    externalId: z.string().min(1).max(60).optional(),
    streetName: z.string().min(1),
    streetNumber: z.string().min(1),
    cityName: z.string().min(1),
    stateName: z.string().min(1),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    reference: z.string().max(256).optional(),
});

export const createPointPosSchema = z.object({
    name: z.string().min(1).max(45),
    storeId: z.union([z.string().min(1), z.number().int().positive()]),
    externalId: z.string().min(1).max(40).regex(/^[a-zA-Z0-9]+$/),
    externalStoreId: z.string().min(1).max(60).optional(),
    category: z.number().int().positive().optional(),
});

export const createPointOrderSchema = z.object({
    deviceId: z.string().min(1),
    amount: positiveMoney,
    externalReference: z
        .string()
        .min(1)
        .max(64)
        .regex(
            /^[A-Za-z0-9_-]+$/,
            'externalReference solo admite letras, números, guion (-) y guion bajo (_)',
        ),
    description: z.string().min(1).max(150).optional(),
    expirationTime: z.string().min(1).optional(),
    printOnTerminal: z.enum(['no_ticket', 'seller_ticket', 'buyer_ticket']).optional(),
    idempotencyKey: nullable(idempotencyKeySchema),
});

export const refundPointOrderSchema = z.preprocess(
    (value) => value ?? {},
    z.object({
        paymentId: z.string().min(1).optional(),
        amount: positiveMoney.optional(),
    }).superRefine((data, ctx) => {
        if ((data.paymentId && !data.amount) || (!data.paymentId && data.amount)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'El reembolso parcial requiere paymentId y amount',
                path: data.paymentId ? ['amount'] : ['paymentId'],
            });
        }
    }),
);

export const mercadoPagoWebhookQuerySchema = z.object({
    'data.id': z.string().min(1).optional(),
    type: z.string().optional(),
    topic: z.string().optional(),
    id: z.string().optional(),
});
