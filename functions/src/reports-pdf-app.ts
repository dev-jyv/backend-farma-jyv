import 'reflect-metadata';
import express from 'express';
import { createHttpApp } from './common/http-pipeline';
import { ReportsPdfModule } from './reports-pdf.module';

let cachedApp: express.Application | undefined;

/**
 * App de la función `reportsPdf`. Comparte con `api` la configuración HTTP
 * (`common/http-pipeline.ts`); solo cambia el módulo raíz.
 */
export const createReportsPdfApp = async (): Promise<express.Application> => {
    if (cachedApp) {
        return cachedApp;
    }

    cachedApp = await createHttpApp(ReportsPdfModule);
    return cachedApp;
};
