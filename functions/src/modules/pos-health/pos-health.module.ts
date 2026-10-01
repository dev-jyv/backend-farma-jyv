import { Module } from '@nestjs/common';
import { PosHealthController } from './pos-health.controller';

@Module({
    controllers: [PosHealthController],
})
export class PosHealthModule {}
