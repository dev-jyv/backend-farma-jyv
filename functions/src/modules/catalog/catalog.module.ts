import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { ProductsController } from './products.controller';
import { SuppliersController } from './suppliers.controller';

@Module({
    controllers: [CategoriesController, ProductsController, SuppliersController],
})
export class CatalogModule {}
