import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InvoicesController } from './invoices.controller';

@Module({
    controllers: [InventoryController, InvoicesController],
})
export class InventoryModule {}
