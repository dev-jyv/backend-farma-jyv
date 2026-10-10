import { Module } from '@nestjs/common';
import { PharmacyServicesController } from './pharmacy-services.controller';
import { ServiceProvidersController } from './service-providers.controller';

@Module({
    controllers: [PharmacyServicesController, ServiceProvidersController],
})
export class PharmacyServicesModule {}
