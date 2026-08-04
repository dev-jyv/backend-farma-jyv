import { z } from 'zod';

const maxTwoDecimals = (value: number): boolean =>
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

export const money = z
    .number()
    .finite()
    .nonnegative()
    .refine(maxTwoDecimals, { message: 'El monto debe tener máximo 2 decimales' });

export const positiveMoney = z
    .number()
    .finite()
    .positive()
    .refine(maxTwoDecimals, { message: 'El monto debe tener máximo 2 decimales' });

export const qty = z
    .number()
    .int('La cantidad debe ser un número entero')
    .positive('La cantidad debe ser mayor a cero');

export const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD')
    .refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, { message: 'Fecha inválida' });

export const parseableDate = z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Fecha inválida' });

export const rfc = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/, 'RFC inválido');

export const phoneMx = z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s()-]/g, ''))
    .refine((value) => /^\d{10}$/.test(value), {
        message: 'El teléfono debe tener 10 dígitos',
    });

export const usoCfdiSchema = z.enum(['G01', 'G02', 'G03', 'I01', 'D01', 'S01']);

export const paginationFields = {
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
};

export const idParamSchema = z.object({
    id: z.string().min(1),
});
