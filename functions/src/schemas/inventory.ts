import { z } from 'zod';
import { isoDate, money, paginationFields, positiveMoney, qty } from './common';
import { createProductSchema } from './catalog';

const expiryDateSchema = isoDate.refine(
    (value) => value >= new Date().toISOString().slice(0, 10),
    { message: 'La fecha de caducidad no puede estar en el pasado' },
);

const lotNumberSchema = z.string().trim().min(1, 'El número de lote es requerido').max(40);

export const inventoryEntryProductSchema = z.object({
    productId: z.string().min(1),
    expiryDate: expiryDateSchema,
    quantity: qty,
    lotNumber: lotNumberSchema,
    costPrice: money.optional(),
});

export const bulkEntryGroupSchema = z.object({
    invoiceId: z.string().min(1).optional(),
    supplierId: z.string().min(1).optional(),
    notes: z.string().optional(),
    items: z.array(inventoryEntryProductSchema).min(1),
}).refine(
    (data) => Boolean(data.invoiceId) !== Boolean(data.supplierId),
    { message: 'Cada entrada debe incluir invoiceId o supplierId, no ambos' },
);

export const bulkCreateEntriesSchema = z.object({
    entries: z.array(bulkEntryGroupSchema).min(1).max(100),
});

export const inventoryEntrySchema = z.object({
    invoiceId: z.string().min(1),
    products: z.array(inventoryEntryProductSchema).min(1).optional(),
    items: z.array(inventoryEntryProductSchema).min(1).optional(),
}).refine(
    (data) => Boolean(data.products?.length || data.items?.length),
    { message: 'Debe incluir al menos un producto' },
).transform((data) => ({
    invoiceId: data.invoiceId,
    products: data.products ?? data.items ?? [],
}));

export const directInventoryEntryItemSchema = z
    .object({
        productId: z.string().min(1).optional(),
        product: createProductSchema.optional(),
        expiryDate: expiryDateSchema,
        quantity: qty,
        lotNumber: lotNumberSchema,
        costPrice: money.optional(),
    })
    .refine(
        (data) => Boolean(data.productId) !== Boolean(data.product),
        { message: 'Cada ítem debe incluir productId o product, no ambos' },
    );

export const directInventoryEntrySchema = z.object({
    supplierId: z.string().min(1),
    notes: z.string().optional(),
    items: z.array(directInventoryEntryItemSchema).min(1),
});

export const inventoryExitSchema = z.object({
    productId: z.string().min(1),
    batchId: z.string().min(1),
    quantity: qty,
    reason: z.enum(['waste', 'expiry']),
    notes: z.string().optional(),
});

export const listBatchesQuerySchema = z.object({
    productId: z.string().min(1),
    ...paginationFields,
});

export const listMovementsQuerySchema = z.object({
    productId: z.string().optional(),
    type: z
        .enum([
            'entry',
            'exit_waste',
            'exit_expiry',
            'sale_adjustment',
            'return_in',
            'adjustment_count',
        ])
        .optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    ...paginationFields,
});

export const listEntriesQuerySchema = z.object({
    supplierId: z.string().optional(),
    invoiceId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    ...paginationFields,
});

export const createInvoiceSchema = z.object({
    supplierId: z.string().min(1, 'El proveedor es obligatorio'),
    invoiceNumber: z.string().trim()
        .min(1, 'El folio es obligatorio')
        .max(60, 'El folio no puede superar 60 caracteres'),
    invoiceDate: isoDate,
    totalAmount: positiveMoney,
    hasInvoice: z.boolean(),
    /**
     * Opcional: se registra la factura aunque el comprobante llegue después (o
     * nunca, cuando el proveedor solo dejó ticket). Lo que sí se valida es la
     * ruta cuando viene, para que no entre un path arbitrario al Storage.
     */
    /**
     * `facturas/` es Cloudflare R2 (los comprobantes nuevos); `uploads/` es
     * Firebase Storage, donde siguen los de antes de la migración. Se aceptan
     * los dos y **solo** esos dos: `fileUrl` es una ruta que propone el cliente,
     * y sin este ancla nombraría cualquier objeto del bucket.
     */
    fileUrl: z
        .string()
        .refine(
            (ruta) => ruta.startsWith('facturas/') || ruta.startsWith('uploads/'),
            'La ruta del comprobante no es válida',
        )
        .optional(),
});

export const listInvoicesQuerySchema = z.object({
    supplierId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    hasInvoice: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});
