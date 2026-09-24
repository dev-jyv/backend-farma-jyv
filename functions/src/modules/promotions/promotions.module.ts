import { Module } from '@nestjs/common';
import { PromotionsController } from './promotions.controller';

@Module({
    controllers: [PromotionsController],
})
export class PromotionsModule {}
