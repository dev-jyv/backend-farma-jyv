import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { GLOBAL_HTTP_PROVIDERS } from './common/http-pipeline';
import {
    AccountingPdfExportsController,
} from './modules/reports-pdf/accounting-pdf-exports.controller';
import { ReportPdfDownloadController } from './modules/reports-pdf/report-pdf-download.controller';
import { ReportPdfExportsController } from './modules/reports-pdf/report-pdf-exports.controller';

/**
 * Módulo raíz de la función `reportsPdf` (SPEC 38): solo las 11 rutas que lanzan
 * Chromium, con los mismos guards, filtro e interceptor que `api`
 * (`GLOBAL_HTTP_PROVIDERS`). **Orden de controllers obligatorio**: las rutas
 * `*.pdf` antes que `ReportPdfDownloadController`, cuyo `:report` las capturaría.
 */
@Module({
    imports: [CommonModule],
    controllers: [
        ReportPdfExportsController,
        ReportPdfDownloadController,
        AccountingPdfExportsController,
    ],
    providers: [...GLOBAL_HTTP_PROVIDERS],
})
export class ReportsPdfModule {}
