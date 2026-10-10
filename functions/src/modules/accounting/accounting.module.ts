import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';

@Module({
    controllers: [AccountingController],
})
export class AccountingModule {}
