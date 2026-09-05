import { z } from 'zod';
import { paginationFields, parseableDate, positiveMoney } from './common';
import { idempotencyKeySchema } from './sales';

const nullable = <T extends z.ZodTypeAny>(schema: T) =>
    schema.nullish().transform((value): z.infer<T> | undefined => value ?? undefined);

export const directChargeStatusSchema = z.enum(['pending', 'approved', 'failed', 'canceled']);
export const directChargeChannelSchema = z.enum(['point', 'online']);

export const createDirectChargeSchema = z.object({
    /** Llave de idempotencia del cobro; sin ella un retry vuelve a cobrar en la terminal. */
    idempotencyKey: nullable(idempotencyKeySchema),
    deviceId: z.string().min(1),
    amount: positiveMoney,
    concept: z.string().trim().min(3).max(150),
});

/** Cobro en línea (Checkout Pro): no hay terminal, solo monto y concepto. */
export const createOnlineDirectChargeSchema = z.object({
    idempotencyKey: nullable(idempotencyKeySchema),
    amount: positiveMoney,
    concept: z.string().trim().min(3).max(150),
});

export const listDirectChargesQuerySchema = z.object({
    from: parseableDate.optional(),
    to: parseableDate.optional(),
    channel: directChargeChannelSchema.optional(),
    status: directChargeStatusSchema.optional(),
    ...paginationFields,
});
