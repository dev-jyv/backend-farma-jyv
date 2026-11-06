import { z } from 'zod';
import { money, qty } from './common';
import { createProductSchema, updateProductSchema } from './catalog';
import { idempotencyKeySchema } from './sales';
import { posDeviceIdSchema } from './pos-health';
import { APP_TIME_ZONE, getZonedYmd } from '../utils/timezone';

/**
 * Entrada de stock desde la caja: **una** partida contra una factura ya
 * registrada. Es un caso más estrecho que `POST /inventory/entries` (que admite
 * varias partidas pero no crear producto) y que `POST /inventory/direct-entries`
 * (que crea producto pero no acepta factura): el mostrador recibe la mercancía
 * pieza por pieza, con la factura enfrente.
 */

/**
 * No se recibe mercancía vencida. La comparación es contra el día de la
 * **captura** en la farmacia (ver `capturedAt` abajo), no contra el día UTC.
 */
const expiryDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de caducidad debe tener formato YYYY-MM-DD');

const lotNumberSchema = z.string().trim().min(1, 'El número de lote es requerido').max(40);

export const listRecentInvoicesQuerySchema = z.object({
    limit: z.string().optional(),
});

export const createStockEntrySchema = z
    .object({
        invoiceId: z.string().min(1),
        lotNumber: lotNumberSchema,
        expiryDate: expiryDateSchema,
        quantity: qty,
        costPrice: money.optional(),
        /** Producto existente al que se le suma el stock. */
        productId: z.string().min(1).optional(),
        /** Correcciones al producto existente; solo se mandan los campos tocados. */
        productUpdate: updateProductSchema.optional(),
        /** Alta de un producto que no está en el catálogo. */
        product: createProductSchema.optional(),
        /**
         * Igual que en las ventas: la caja genera la llave una vez por entrada y
         * la reenvía sin cambios en cada reintento. Sin ella, un timeout tras un
         * alta que **sí** se aplicó duplicaba el lote al reintentar — stock
         * fantasma que nadie cuadra contra la factura.
         */
        idempotencyKey: idempotencyKeySchema.optional(),
        /**
         * Caja que capturó la entrada (SPEC 54). Con él la llave es
         * `<deviceId>:<llave>`: si otro usuario inicia sesión en esa caja y la cola
         * reenvía la entrada, sigue siendo la misma llave y no se aplica dos veces.
         */
        deviceId: posDeviceIdSchema.optional(),
        /**
         * Momento de la captura en la caja (ISO con zona, SPEC 59). La caducidad se
         * valida contra **ese** día en `America/Mexico_City`, no contra el del sync:
         * capturada sin red el día 5 con caducidad del 6, se acepta aunque suba el 7.
         */
        capturedAt: z.string().datetime({ offset: true }).optional(),
        /**
         * "Sí, es otra partida" (SPEC 58): el cajero confirmó que una partida igual a
         * otra ya aplicada en la factura (otra llave) es mercancía distinta.
         */
        confirmDuplicate: z.boolean().optional(),
    })
    .superRefine((data, ctx) => {
        const capturedMs = data.capturedAt ? Date.parse(data.capturedAt) : Date.now();
        // Un `capturedAt` mal formado ya trae su propio error.
        if (Number.isFinite(capturedMs) &&
            data.expiryDate < getZonedYmd(capturedMs, APP_TIME_ZONE)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expiryDate'],
                message: 'La fecha de caducidad no puede estar en el pasado',
            });
        }
    })
    .refine((data) => Boolean(data.productId) !== Boolean(data.product), {
        message: 'La entrada debe incluir productId o product, no ambos',
    })
    .refine((data) => !(data.productUpdate && !data.productId), {
        message: 'productUpdate solo aplica sobre un producto existente',
        path: ['productUpdate'],
    });
