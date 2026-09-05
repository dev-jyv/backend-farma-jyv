import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response-envelope.interceptor';
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
import { SaleReturnsModule } from './modules/sale-returns/sale-returns.module';
import { AuditModule } from './modules/audit/audit.module';
import { ReportsModule } from './modules/reports/reports.module';
import { CashSessionsModule } from './modules/cash-sessions/cash-sessions.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ClinicModule } from './modules/clinic/clinic.module';
import { DirectChargesModule } from './modules/direct-charges/direct-charges.module';
import { StockEntriesModule } from './modules/stock-entries/stock-entries.module';
import { PharmacyServicesModule } from './modules/pharmacy-services/pharmacy-services.module';

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
        SaleReturnsModule,
        AuditModule,
        ReportsModule,
        CashSessionsModule,
        PaymentsModule,
        CustomersModule,
        ClinicModule,
        DirectChargesModule,
        StockEntriesModule,
        PharmacyServicesModule,
    ],
    controllers: [HealthController],
    providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    ],
})
export class AppModule {}
