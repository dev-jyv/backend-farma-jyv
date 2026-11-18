import { Injectable, PipeTransform } from '@nestjs/common';
import { z, ZodError } from 'zod';
import { badRequest } from '../utils/errors';

/**
 * `ZodError.message` por default es el arreglo de issues serializado en JSON
 * (`JSON.stringify(this.issues, null, 2)`) — perfecto para logs, ilegible como
 * mensaje de error para el cajero. Aquí se arma uno legible por humano.
 */
export const formatZodError = (error: ZodError): string =>
    error.issues
        .map((issue) => (issue.path.length
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message))
        .join(' · ');

/**
 * Mensajes de Zod en español para los errores que el esquema no redacta él mismo
 * (los `message` propios de cada esquema mandan sobre este mapa). Lo usa el lote
 * de ventas (SPEC 48), cuyo error por índice lo lee el cajero en la caja.
 */
export const spanishZodErrorMap: z.core.$ZodErrorMap = (issue) => {
    switch (issue.code) {
    case 'invalid_type':
        return issue.input === undefined
            ? 'Campo requerido'
            : `Tipo inválido: se esperaba ${issue.expected} y llegó ${describeInput(issue.input)}`;
    case 'too_small':
        return issue.origin === 'array' || issue.origin === 'set'
            ? `Debe tener al menos ${issue.minimum} elemento(s)`
            : issue.origin === 'string'
                ? `Debe tener al menos ${issue.minimum} carácter(es)`
                : `Debe ser mayor${issue.inclusive ? ' o igual' : ''} a ${issue.minimum}`;
    case 'too_big':
        return issue.origin === 'array' || issue.origin === 'set'
            ? `Debe tener como máximo ${issue.maximum} elemento(s)`
            : issue.origin === 'string'
                ? `Debe tener como máximo ${issue.maximum} carácter(es)`
                : `Debe ser menor${issue.inclusive ? ' o igual' : ''} a ${issue.maximum}`;
    case 'invalid_value':
        return issue.values.length === 1
            ? `Valor inválido; se esperaba ${JSON.stringify(issue.values[0])}`
            : `Valor inválido; se esperaba: ${issue.values.map(String).join(', ')}`;
    case 'invalid_format':
        return issue.format === 'datetime' || issue.format === 'date'
            ? 'Fecha inválida'
            : 'Texto con formato inválido';
    case 'unrecognized_keys':
        return `Campos no permitidos: ${issue.keys.join(', ')}`;
    case 'invalid_union':
        return 'Valor inválido';
    case 'not_multiple_of':
        return `Debe ser múltiplo de ${issue.divisor}`;
    default:
        // Sin mensaje propio: Zod usa el suyo.
        return undefined;
    }
};

/** Nombre del tipo recibido, como lo decía Zod 3 (`null`, `array`, `nan`…). */
const describeInput = (input: unknown): string => {
    if (input === null) return 'null';
    if (Array.isArray(input)) return 'array';
    if (typeof input === 'number' && Number.isNaN(input)) return 'nan';
    return typeof input;
};

@Injectable()
export class ZodValidationPipe<T extends z.ZodType = z.ZodType> implements PipeTransform {
    constructor(private readonly schema: T) {}

    transform(value: unknown): z.output<T> {
        try {
            return this.schema.parse(value);
        } catch (error) {
            const message = error instanceof ZodError
                ? formatZodError(error)
                : error instanceof Error
                    ? error.message
                    : 'Datos de entrada inválidos';
            // Un payload que no pasa el esquema es la validación por excelencia: la
            // caja la muestra y no la reintenta igual (SPEC 49).
            throw badRequest(message, 'VALIDATION');
        }
    }
}
