import { Module } from '@nestjs/common';
import { CouponsController } from './coupons.controller';
import { PromotionsController } from './promotions.controller';

@Module({
    controllers: [PromotionsController, CouponsController],
})
export class PromotionsModule {}
