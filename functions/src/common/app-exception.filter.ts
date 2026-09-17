import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { AuthUser } from '../types';

const extractHttpExceptionMessage = (error: HttpException): string => {
    const body = error.getResponse();
    if (typeof body === 'string') {
        return body;
    }
    const message = (body as { message?: string | string[] }).message ?? error.message;
    return Array.isArray(message) ? message.join(', ') : message;
};

/** `authUser` lo cuelga `AuthGuard`; en una ruta pública no existe. */
type AuthenticatedRequest = Request & { authUser?: AuthUser };

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger('ExceptionsHandler');

    /**
     * Deja el 500 en los logs con **stack completo y contexto de la petición**.
     *
     * Cloud Error Reporting agrupa por el stack, así que este formato basta para
     * que el error aparezca solo en la consola de Google y dispare la alerta,
     * sin instalar un SDK aparte. El contexto —ruta, método, usuario— es lo que
     * decide si se puede reproducir: un "TypeError: cannot read x" suelto no le
     * sirve a nadie a las once de la noche.
     *
     * Nunca se registra el cuerpo de la petición: lleva cobros, RFC y datos de
     * paciente, y los logs se ven con permisos distintos a los de la aplicación.
     */
    private reportUnexpected(error: unknown, request: AuthenticatedRequest): void {
        const contexto = [
            `${request?.method ?? '?'} ${request?.originalUrl ?? request?.url ?? '?'}`,
            request?.authUser?.uid ? `uid=${request.authUser.uid}` : 'sin sesión',
            request?.authUser?.role?.slug ? `rol=${request.authUser.role.slug}` : null,
        ].filter(Boolean).join(' · ');

        this.logger.error(
            error instanceof Error
                ? `${contexto}\n${error.stack ?? error.message}`
                : `${contexto}\n${String(error)}`,
        );
    }

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

        this.reportUnexpected(error, host.switchToHttp().getRequest<AuthenticatedRequest>());
        response.status(500).json({
            error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' },
        });
    }
}
