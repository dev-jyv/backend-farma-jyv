import { z } from 'zod';

/**
 * Contrato del JSON de facturas-RAG. Normaliza la salida del LLM en vez de
 * rechazarla: un campo ilegible queda en `null` y el usuario lo corrige en el
 * formulario de revisión, que es donde el dato se confirma.
 */

export const INVOICE_RAG_MAX_ITEMS = 200;
export const INVOICE_RAG_MAX_TAXES = 20;
export const INVOICE_RAG_MAX_EMBED_CHARS = 8000;

const toNumberOrNull = (value: unknown): number | null => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const n = Number(value.replace(/[$,\s]/g, ''));
        return value.trim() && Number.isFinite(n) ? n : null;
    }
    return null;
};

const nullableNumber = z.preprocess(toNumberOrNull, z.number().nullable());

const nullableText = (max: number) => z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null),
    z.string().nullable(),
);

const partySchema = z
    .object({
        name: nullableText(300),
        rfc: z.preprocess(
            (value) => (typeof value === 'string' && value.trim()
                ? value.trim().toUpperCase().slice(0, 13)
                : null),
            z.string().nullable(),
        ),
    })
    .catch({ name: null, rfc: null });

const taxSchema = z.object({
    type: z.preprocess(
        (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : 'IVA'),
        z.string(),
    ),
    rate: nullableNumber,
    amount: z.preprocess((value) => toNumberOrNull(value) ?? 0, z.number()),
});

const itemSchema = z.object({
    description: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().slice(0, 500) : ''),
        z.string(),
    ),
    quantity: nullableNumber,
    unitPrice: nullableNumber,
    amount: nullableNumber,
});

const boundedArray = <T extends z.ZodTypeAny>(schema: T, max: number) => z
    .unknown()
    .transform((value): z.output<T>[] => (Array.isArray(value)
        ? value.slice(0, max).flatMap((row) => {
            const parsed = schema.safeParse(row);
            return parsed.success ? [parsed.data] : [];
        })
        : []));

export const invoiceRagDataSchema = z.object({
    documentType: z.enum(['invoice', 'receipt', 'other']).catch('other'),
    confidence: z.preprocess(
        (value) => Math.min(1, Math.max(0, toNumberOrNull(value) ?? 0)),
        z.number(),
    ),
    issuer: partySchema,
    receiver: partySchema,
    folio: nullableText(100),
    cfdiUuid: z.preprocess(
        (value) => (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value.trim())
            ? value.trim().toUpperCase()
            : null),
        z.string().nullable(),
    ),
    issueDate: z.preprocess(
        (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
            ? value.trim()
            : null),
        z.string().nullable(),
    ),
    currency: z.preprocess(
        (value) => (typeof value === 'string' && /^[a-z]{3}$/i.test(value.trim())
            ? value.trim().toUpperCase()
            : null),
        z.string().nullable(),
    ),
    paymentMethod: nullableText(100),
    subtotal: nullableNumber,
    taxes: boundedArray(taxSchema, INVOICE_RAG_MAX_TAXES),
    total: nullableNumber,
    items: boundedArray(itemSchema, INVOICE_RAG_MAX_ITEMS),
    notes: nullableText(2000),
});

export type InvoiceRagData = z.infer<typeof invoiceRagDataSchema>;

export const invoiceRagEmbedSchema = z.object({
    text: z
        .string()
        .trim()
        .min(1, 'El texto es requerido')
        .max(INVOICE_RAG_MAX_EMBED_CHARS, `Máximo ${INVOICE_RAG_MAX_EMBED_CHARS} caracteres`),
});

/**
 * JSON Schema estricto que se manda a OpenRouter (`response_format`). En modo
 * `strict` todas las llaves son obligatorias y lo opcional se expresa con `null`.
 */
const nullable = (type: 'string' | 'number') => ({ type: [type, 'null'] });

const partyJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'rfc'],
    properties: { name: nullable('string'), rfc: nullable('string') },
};

export const INVOICE_RAG_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'documentType', 'confidence', 'issuer', 'receiver', 'folio', 'cfdiUuid', 'issueDate',
        'currency', 'paymentMethod', 'subtotal', 'taxes', 'total', 'items', 'notes',
    ],
    properties: {
        documentType: { type: 'string', enum: ['invoice', 'receipt', 'other'] },
        confidence: { type: 'number' },
        issuer: partyJsonSchema,
        receiver: partyJsonSchema,
        folio: nullable('string'),
        cfdiUuid: nullable('string'),
        issueDate: nullable('string'),
        currency: nullable('string'),
        paymentMethod: nullable('string'),
        subtotal: nullable('number'),
        taxes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'rate', 'amount'],
                properties: {
                    type: { type: 'string' },
                    rate: nullable('number'),
                    amount: { type: 'number' },
                },
            },
        },
        total: nullable('number'),
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['description', 'quantity', 'unitPrice', 'amount'],
                properties: {
                    description: { type: 'string' },
                    quantity: nullable('number'),
                    unitPrice: nullable('number'),
                    amount: nullable('number'),
                },
            },
        },
        notes: nullable('string'),
    },
} as const;
