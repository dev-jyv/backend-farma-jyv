import { Module } from '@nestjs/common';
import { AccountingPdfExportsController } from '../reports-pdf/accounting-pdf-exports.controller';
import { AccountingController } from './accounting.controller';

/**
 * `AccountingPdfExportsController` se registra aquí solo durante la transición
 * de SPEC 38 (el panel viejo todavía pide los PDF a `api`); el PR de borrado lo
 * quita y los PDF quedan solo en `reportsPdf`.
 */
@Module({
    controllers: [AccountingController, AccountingPdfExportsController],
})
export class AccountingModule {}
