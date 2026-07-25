import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';

@Module({
    controllers: [SalesController],
})
export class SalesModule {}
