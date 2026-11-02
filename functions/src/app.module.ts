import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { GLOBAL_HTTP_PROVIDERS } from './common/http-pipeline';
import { HealthController } from './modules/health/health.controller';
import { IdentityModule } from './modules/identity/identity.module';
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
import { PromotionsModule } from './modules/promotions/promotions.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { InvoiceRagModule } from './modules/invoice-rag/invoice-rag.module';
import { AssistantModule } from './modules/assistant/assistant.module';

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
        PromotionsModule,
        AccountingModule,
        InvoiceRagModule,
        AssistantModule,
    ],
    controllers: [HealthController],
    // Guards (AppCheckGuard → AuthGuard → PermissionsGuard), filtro e interceptor compartidos con
    // `reportsPdf`: ver `common/http-pipeline.ts`.
    providers: [...GLOBAL_HTTP_PROVIDERS],
})
export class AppModule {}
