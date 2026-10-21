import 'reflect-metadata';
import express from 'express';
import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsMiddleware } from './middleware/cors';

let cachedApp: express.Application | undefined;

/** Niveles de log de Nest activos en producción: errores y avisos, sin ruido de arranque. */
export const NEST_LOG_LEVELS: LogLevel[] = ['error', 'warn'];

/**
 * Una sola instancia del parser: `express.json()` es una fábrica, invocarla
 * dentro del middleware construía un parser nuevo en cada petición.
 */
const jsonParser = express.json();

export const createApp = async (): Promise<express.Application> => {
    if (cachedApp) {
        return cachedApp;
    }

    const expressApp = express();

    expressApp.use(corsMiddleware);
    expressApp.use((req, res, next) => {
        // Los multipart los parsea el interceptor de Busboy, que necesita el
        // cuerpo sin tocar (o `req.rawBody` en Cloud Functions).
        if (req.is('multipart/form-data')) {
            next();
            return;
        }
        jsonParser(req, res, next);
    });

    const nestApp = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
        bodyParser: false,
        // Con `logger: false` los `Logger.error`/`warn` no escriben nada: ni el stack
        // de los 500 (`AppExceptionFilter`), ni los errores de webhooks de Mercado
        // Pago, ni el aviso de ventas sin llave. Los logs de Cloud Run los recogen
        // de stdout/stderr, así que basta con dejar activos solo estos dos niveles.
        logger: NEST_LOG_LEVELS,
    });
    nestApp.setGlobalPrefix('v1');
    await nestApp.init();

    cachedApp = expressApp;
    return cachedApp;
};
