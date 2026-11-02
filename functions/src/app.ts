import 'reflect-metadata';
import express from 'express';
import { AppModule } from './app.module';
import { createHttpApp } from './common/http-pipeline';

let cachedApp: express.Application | undefined;

/**
 * App de la función `api`. CORS, guards, filtro y prefijo salen de
 * `common/http-pipeline.ts`, compartido con `reportsPdf`.
 */
export const createApp = async (): Promise<express.Application> => {
    if (cachedApp) {
        return cachedApp;
    }

    cachedApp = await createHttpApp(AppModule);
    return cachedApp;
};
