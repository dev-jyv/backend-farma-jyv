import 'reflect-metadata';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsMiddleware } from './middleware/cors';

let cachedApp: express.Application | undefined;

export const createApp = async (): Promise<express.Application> => {
    if (cachedApp) {
        return cachedApp;
    }

    const expressApp = express();

    expressApp.use(corsMiddleware);
    expressApp.use((req, res, next) => {
        if (req.is('multipart/form-data')) {
            next();
            return;
        }
        express.json()(req, res, next);
    });

    const nestApp = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
        bodyParser: false,
    });
    nestApp.setGlobalPrefix('v1');
    await nestApp.init();

    cachedApp = expressApp;
    return cachedApp;
};
