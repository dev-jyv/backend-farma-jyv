import { z } from 'zod';

/**
 * `schema.optional()` a secas solo se salta la validación cuando el valor es
 * `undefined` — un string vacío (`''`, lo que manda un form reactivo cuando el
 * cajero deja el campo en blanco) sigue corriendo `.email()`/`.refine()` y
 * truena. Esto lo trata como ausente antes de validar.
 */
export const optionalNonEmpty = <T extends z.ZodTypeAny>(schema: T) =>
    z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const maxTwoDecimals = (value: number): boolean =>
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

/**
 * Techo de cualquier importe que entre por la API.
 *
 * No es una regla de negocio, es un tope de cordura: sin él estos schemas
 * aceptaban cualquier `number` finito, así que un `amount` de 9e14 en un
 * movimiento de caja se guardaba tal cual, descuadraba el corte y contaminaba
 * los reportes agregados (y en cobros directos viajaba a Mercado Pago). Diez
 * millones de pesos queda muy por encima de cualquier operación real de una
 * farmacia y muy por debajo de donde los flotantes empiezan a perder centavos.
 */
export const MAX_MONEY = 10_000_000;

export const money = z
    .number()
    .finite()
    .nonnegative()
    .max(MAX_MONEY, `El monto no puede superar ${MAX_MONEY}`)
    .refine(maxTwoDecimals, { message: 'El monto debe tener máximo 2 decimales' });

export const positiveMoney = z
    .number()
    .finite()
    .positive()
    .max(MAX_MONEY, `El monto no puede superar ${MAX_MONEY}`)
    .refine(maxTwoDecimals, { message: 'El monto debe tener máximo 2 decimales' });

/**
 * Monto que **sí** puede ser negativo: el fondo con el que abre un turno.
 *
 * El fondo hereda el efectivo que quedó del corte anterior, y ese saldo puede
 * quedar en rojo si se retiró más de lo que había en el cajón. Recortarlo a
 * cero no hacía aparecer el dinero: solo abría el turno con un fondo falso, y
 * el faltante reaparecía en el arqueo del siguiente cierre sin explicación.
 *
 * Lo mismo vale para el conteo del cierre: arrastra ese fondo y la caja puede
 * quedar en rojo por un gasto de más o un movimiento mal registrado.
 */
export const signedMoney = z
    .number()
    .finite()
    .min(-MAX_MONEY, `El monto no puede ser menor a -${MAX_MONEY}`)
    .max(MAX_MONEY, `El monto no puede superar ${MAX_MONEY}`)
    .refine(maxTwoDecimals, { message: 'El monto debe tener máximo 2 decimales' });

/** Mismo criterio que `MAX_MONEY`: ninguna partida real mueve un millón de piezas. */
export const MAX_QTY = 1_000_000;

export const qty = z
    .number()
    .int('La cantidad debe ser un número entero')
    .positive('La cantidad debe ser mayor a cero')
    .max(MAX_QTY, `La cantidad no puede superar ${MAX_QTY}`);

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
