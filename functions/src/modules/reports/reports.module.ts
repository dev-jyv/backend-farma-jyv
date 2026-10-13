import { Module } from '@nestjs/common';
import { ReportExportsController } from './report-exports.controller';
import { ReportsController } from './reports.controller';

@Module({
    controllers: [ReportsController, ReportExportsController],
})
export class ReportsModule {}
