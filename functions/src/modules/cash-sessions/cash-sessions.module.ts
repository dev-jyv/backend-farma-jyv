import { Module } from '@nestjs/common';
import { CashSessionsController } from './cash-sessions.controller';

@Module({
    controllers: [CashSessionsController],
})
export class CashSessionsModule {}
