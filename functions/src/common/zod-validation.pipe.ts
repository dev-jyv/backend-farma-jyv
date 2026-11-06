import { Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodErrorMap, ZodIssueCode, ZodSchema } from 'zod';
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
export const spanishZodErrorMap: ZodErrorMap = (issue, ctx) => {
    switch (issue.code) {
    case ZodIssueCode.invalid_type:
        return {
            message: issue.received === 'undefined'
                ? 'Campo requerido'
                : `Tipo inválido: se esperaba ${issue.expected} y llegó ${issue.received}`,
        };
    case ZodIssueCode.too_small:
        return {
            message: issue.type === 'array'
                ? `Debe tener al menos ${issue.minimum} elemento(s)`
                : issue.type === 'string'
                    ? `Debe tener al menos ${issue.minimum} carácter(es)`
                    : `Debe ser mayor${issue.inclusive ? ' o igual' : ''} a ${issue.minimum}`,
        };
    case ZodIssueCode.too_big:
        return {
            message: issue.type === 'array'
                ? `Debe tener como máximo ${issue.maximum} elemento(s)`
                : issue.type === 'string'
                    ? `Debe tener como máximo ${issue.maximum} carácter(es)`
                    : `Debe ser menor${issue.inclusive ? ' o igual' : ''} a ${issue.maximum}`,
        };
    case ZodIssueCode.invalid_enum_value:
        return { message: `Valor inválido; se esperaba: ${issue.options.join(', ')}` };
    case ZodIssueCode.invalid_literal:
        return { message: `Valor inválido; se esperaba ${JSON.stringify(issue.expected)}` };
    case ZodIssueCode.invalid_string:
        return { message: 'Texto con formato inválido' };
    case ZodIssueCode.invalid_date:
        return { message: 'Fecha inválida' };
    case ZodIssueCode.unrecognized_keys:
        return { message: `Campos no permitidos: ${issue.keys.join(', ')}` };
    case ZodIssueCode.invalid_union:
    case ZodIssueCode.invalid_union_discriminator:
        return { message: 'Valor inválido' };
    case ZodIssueCode.not_multiple_of:
        return { message: `Debe ser múltiplo de ${issue.multipleOf}` };
    case ZodIssueCode.not_finite:
        return { message: 'Debe ser un número finito' };
    default:
        return { message: ctx.defaultError };
    }
};

@Injectable()
export class ZodValidationPipe implements PipeTransform {
    constructor(private readonly schema: ZodSchema) {}

    transform(value: unknown) {
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
