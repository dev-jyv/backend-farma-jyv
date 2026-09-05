import { z } from 'zod';
import { money, qty } from './common';
import { createProductSchema, updateProductSchema } from './catalog';

/**
 * Entrada de stock desde la caja: **una** partida contra una factura ya
 * registrada. Es un caso más estrecho que `POST /inventory/entries` (que admite
 * varias partidas pero no crear producto) y que `POST /inventory/direct-entries`
 * (que crea producto pero no acepta factura): el mostrador recibe la mercancía
 * pieza por pieza, con la factura enfrente.
 */

/** Mismo criterio que `schemas/inventory.ts`: no se recibe mercancía vencida. */
const expiryDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de caducidad debe tener formato YYYY-MM-DD')
    .refine((value) => value >= new Date().toISOString().slice(0, 10), {
        message: 'La fecha de caducidad no puede estar en el pasado',
    });

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
    })
    .refine((data) => Boolean(data.productId) !== Boolean(data.product), {
        message: 'La entrada debe incluir productId o product, no ambos',
    })
    .refine((data) => !(data.productUpdate && !data.productId), {
        message: 'productUpdate solo aplica sobre un producto existente',
        path: ['productUpdate'],
    });
