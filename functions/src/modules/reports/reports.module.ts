import { Module } from '@nestjs/common';
import { ReportPdfExportsController } from '../reports-pdf/report-pdf-exports.controller';
import { ReportExportsController } from './report-exports.controller';
import { ReportsController } from './reports.controller';

/**
 * `ReportPdfExportsController` se registra aquí solo durante la transición de
 * SPEC 38: las rutas `*.pdf` ya las sirve `reportsPdf`, pero el panel viejo en
 * caché todavía las pide a `api`. El PR de borrado lo quita de esta lista.
 * **Orden obligatorio**: antes que `ReportExportsController`, cuyo `:report`
 * capturaría `sales-daily.pdf` y respondería 400.
 */
@Module({
    controllers: [ReportsController, ReportPdfExportsController, ReportExportsController],
})
export class ReportsModule {}
