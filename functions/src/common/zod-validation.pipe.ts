import { Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';
import { badRequest } from '../utils/errors';

/**
 * `ZodError.message` por default es el arreglo de issues serializado en JSON
 * (`JSON.stringify(this.issues, null, 2)`) — perfecto para logs, ilegible como
 * mensaje de error para el cajero. Aquí se arma uno legible por humano.
 */
const formatZodError = (error: ZodError): string =>
    error.issues
        .map((issue) => (issue.path.length
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message))
        .join(' · ');

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
            throw badRequest(message);
        }
    }
}
