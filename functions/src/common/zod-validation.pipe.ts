import { Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { badRequest } from '../utils/errors';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
    constructor(private readonly schema: ZodSchema) {}

    transform(value: unknown) {
        try {
            return this.schema.parse(value);
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : 'Datos de entrada inválidos';
            throw badRequest(message);
        }
    }
}
