import { Module } from '@nestjs/common';
import { DirectChargesController } from './direct-charges.controller';

@Module({
    controllers: [DirectChargesController],
})
export class DirectChargesModule {}
