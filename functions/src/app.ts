import 'reflect-metadata';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsMiddleware } from './middleware/cors';

let cachedApp: express.Application | undefined;

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
        logger: false,
    });
    nestApp.setGlobalPrefix('v1');
    await nestApp.init();

    cachedApp = expressApp;
    return cachedApp;
};
