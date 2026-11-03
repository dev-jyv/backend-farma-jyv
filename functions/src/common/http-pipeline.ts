import express from 'express';
import { LogLevel, Provider, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppExceptionFilter } from './app-exception.filter';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';
import { AppCheckGuard } from '../modules/identity/guards/app-check.guard';
import { AuthGuard } from '../modules/identity/guards/auth.guard';
import { PermissionsGuard } from '../modules/identity/guards/permissions.guard';
import { corsMiddleware } from '../middleware/cors';

/**
 * Configuración HTTP común a todas las apps Nest que se exportan como función
 * (`api` y `reportsPdf`, SPEC 38). Existe para que las dos no puedan divergir en
 * lo que decide el acceso: CORS, guards, filtro de errores, prefijo y logger.
 * Si una ruta se sirve en dos funciones, tiene que contestar lo mismo en las
 * dos; cualquier ajuste a este camino se hace aquí, nunca en una sola app.
 */

/** Niveles de log de Nest activos en producción: errores y avisos, sin ruido de arranque. */
export const NEST_LOG_LEVELS: LogLevel[] = ['error', 'warn'];

/**
 * Guards, filtro e interceptor globales. **El orden importa**: App Check (SPEC 41,
 * solo registra, nunca rechaza) → `AuthGuard`, que debe resolver `req.authUser`
 * antes de que `PermissionsGuard` lo consulte. `reportsPdf` mide App Check igual
 * que `api`: el panel también descarga los PDF.
 */
export const GLOBAL_HTTP_PROVIDERS: Provider[] = [
    { provide: APP_GUARD, useClass: AppCheckGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
];

/**
 * Una sola instancia del parser: `express.json()` es una fábrica, invocarla
 * dentro del middleware construía un parser nuevo en cada petición.
 */
const jsonParser = express.json();

/**
 * Monta un módulo raíz de Nest sobre un Express nuevo con CORS, parser JSON
 * condicional y prefijo `v1`. Quien lo llama cachea el resultado.
 */
export const createHttpApp = async (rootModule: Type<unknown>): Promise<express.Application> => {
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

    const nestApp = await NestFactory.create(rootModule, new ExpressAdapter(expressApp), {
        bodyParser: false,
        // Con `logger: false` los `Logger.error`/`warn` no escriben nada: ni el stack
        // de los 500 (`AppExceptionFilter`), ni los errores de webhooks de Mercado
        // Pago, ni el aviso de ventas sin llave. Los logs de Cloud Run los recogen
        // de stdout/stderr, así que basta con dejar activos solo estos dos niveles.
        logger: NEST_LOG_LEVELS,
    });
    nestApp.setGlobalPrefix('v1');
    await nestApp.init();

    return expressApp;
};
