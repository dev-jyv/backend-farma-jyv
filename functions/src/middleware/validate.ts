import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { badRequest } from '../utils/errors';

interface ValidationTarget {
    body?: ZodSchema;
    query?: ZodSchema;
    params?: ZodSchema;
}

export const validate = (schemas: ValidationTarget) =>
    (req: Request, _res: Response, next: NextFunction): void => {
        try {
            if (schemas.body) {
                req.body = schemas.body.parse(req.body);
            }
            if (schemas.query) {
                req.query = schemas.query.parse(req.query) as Request['query'];
            }
            if (schemas.params) {
                req.params = schemas.params.parse(req.params) as Request['params'];
            }
            next();
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : 'Datos de entrada inválidos';
            next(badRequest(message));
        }
    };
