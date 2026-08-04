import { Module } from '@nestjs/common';
import { SaleReturnsController } from './sale-returns.controller';

@Module({
    controllers: [SaleReturnsController],
})
export class SaleReturnsModule {}
