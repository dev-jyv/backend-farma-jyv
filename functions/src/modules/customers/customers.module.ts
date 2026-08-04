import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';

@Module({
    controllers: [CustomersController],
})
export class CustomersModule {}
