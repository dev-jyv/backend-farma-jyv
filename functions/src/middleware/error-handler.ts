import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';

export const errorHandler = (
    error: Error,
    _req: Request,
    res: Response,
    _next: NextFunction, // eslint-disable-line @typescript-eslint/no-unused-vars
): void => {
    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            error: {
                code: error.code,
                message: error.message,
            },
        });
        return;
    }

    console.error('Unhandled error:', error);
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: 'Error interno del servidor',
        },
    });
};
