import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { HealthController } from './modules/health/health.controller';
import { IdentityModule } from './modules/identity/identity.module';
import { AuthGuard } from './modules/identity/guards/auth.guard';
import { PermissionsGuard } from './modules/identity/guards/permissions.guard';
import { DoctorModule } from './modules/doctor/doctor.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { InternalModule } from './modules/internal/internal.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';

@Module({
    imports: [
        CommonModule,
        IdentityModule,
        DoctorModule,
        UploadsModule,
        InternalModule,
        CatalogModule,
        InventoryModule,
        SalesModule,
    ],
    controllers: [HealthController],
    providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
    ],
})
export class AppModule {}
