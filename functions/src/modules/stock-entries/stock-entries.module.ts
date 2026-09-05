import { Module } from '@nestjs/common';
import { StockEntriesController } from './stock-entries.controller';

@Module({
    controllers: [StockEntriesController],
})
export class StockEntriesModule {}
