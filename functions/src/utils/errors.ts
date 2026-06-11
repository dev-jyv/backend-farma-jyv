export class AppError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'AppError';
    }
}

export const notFound = (resource: string): AppError =>
    new AppError(404, 'NOT_FOUND', `${resource} no encontrado`);

export const forbidden = (message = 'No tienes permisos para esta acción'): AppError =>
    new AppError(403, 'FORBIDDEN', message);

export const unauthorized = (message = 'Token inválido o ausente'): AppError =>
    new AppError(401, 'UNAUTHORIZED', message);

export const badRequest = (message: string): AppError =>
    new AppError(400, 'BAD_REQUEST', message);

export const conflict = (message: string): AppError =>
    new AppError(409, 'CONFLICT', message);
