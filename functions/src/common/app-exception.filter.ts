import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { AppError } from '../utils/errors';

const extractHttpExceptionMessage = (error: HttpException): string => {
    const body = error.getResponse();
    if (typeof body === 'string') {
        return body;
    }
    const message = (body as { message?: string | string[] }).message ?? error.message;
    return Array.isArray(message) ? message.join(', ') : message;
};

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger('ExceptionsHandler');

    catch(error: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>();

        if (error instanceof AppError) {
            response.status(error.statusCode).json({
                error: { code: error.code, message: error.message },
            });
            return;
        }

        // Nest lanza sus propias HttpException (ej. 404 en rutas no mapeadas)
        // fuera del flujo de AppError - deben respetar su status, no caer a 500.
        if (error instanceof HttpException) {
            response.status(error.getStatus()).json({
                error: { code: 'HTTP_ERROR', message: extractHttpExceptionMessage(error) },
            });
            return;
        }

        this.logger.error(error instanceof Error ? error.stack : error);
        response.status(500).json({
            error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' },
        });
    }
}
