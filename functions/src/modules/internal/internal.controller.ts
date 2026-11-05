import { Controller, Headers, Post, Query } from '@nestjs/common';
import { runRoleMigration } from '../../services/roles.service';
import { badRequest } from '../../utils/errors';
import { assertMigrateSecret } from '../../utils/migrate-secret';
import { Public } from '../identity/decorators/public.decorator';

@Controller('internal')
export class InternalController {
    @Public()
    @Post('migrate-roles')
    async migrateRoles(@Headers('x-migrate-secret') providedSecret?: string) {
        assertMigrateSecret(providedSecret);

        const report = await runRoleMigration();

        // `migrated` se conserva para no romper al cliente del script de
        // migración, que ya lo lee.
        return { data: { ...report, migrated: report.usersMigrated } };
    }

    @Public()
    @Post('reports/daily')
    async triggerDailyReport(
        @Headers('x-migrate-secret') providedSecret?: string,
        @Query('date') date?: string,
    ) {
        assertMigrateSecret(providedSecret);
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw badRequest('La fecha debe tener formato YYYY-MM-DD');
        }

        // Importado aquí y no arriba: la cadena del correo arrastra Resend,
        // React y React Email (~6 MB). Estático, el arranque en frío del API los
        // parseaba en cada instancia para tres rutas de disparo manual.
        const { sendDailySalesReport } = await import(
            '../../services/sales-report-sender.service'
        );
        const result = await sendDailySalesReport(date);
        return { data: { sent: true, ...result } };
    }

    @Public()
    /** Disparo manual de las alertas de inventario (`force` ignora el "sin novedades"). */
    @Post('reports/inventory-alerts')
    async triggerInventoryAlerts(
        @Headers('x-migrate-secret') providedSecret?: string,
        @Query('force') force?: string,
    ) {
        assertMigrateSecret(providedSecret);
        const { sendInventoryAlertsReport } = await import(
            '../../services/inventory-alerts-sender.service'
        );
        const result = await sendInventoryAlertsReport({ force: force === 'true' });
        return { data: result };
    }

    @Public()
    @Post('reports/monthly')
    async triggerMonthlyReport(
        @Headers('x-migrate-secret') providedSecret?: string,
        @Query('month') month?: string,
    ) {
        assertMigrateSecret(providedSecret);
        if (month && !/^\d{4}-\d{2}$/.test(month)) {
            throw badRequest('El mes debe tener formato YYYY-MM');
        }

        const period = month
            ? { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) }
            : undefined;
        const { sendMonthlySalesReport } = await import(
            '../../services/sales-report-sender.service'
        );
        const result = await sendMonthlySalesReport(period?.year, period?.month);
        return { data: { sent: true, ...result } };
    }
}
