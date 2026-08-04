import { Controller, Headers, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { migrateUsersToRoleIds, seedSystemRoles } from '../../services/roles.service';
import {
    sendDailySalesReport,
    sendMonthlySalesReport,
} from '../../services/sales-report-sender.service';
import { sendInventoryAlertsReport } from '../../services/inventory-alerts-sender.service';
import { badRequest, forbidden } from '../../utils/errors';
import { Public } from '../identity/decorators/public.decorator';

const secretMatches = (provided: string, expected: string): boolean => {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
};

const assertMigrateSecret = (providedSecret?: string): void => {
    const secret = process.env.MIGRATE_SECRET;
    if (!secret || !providedSecret || !secretMatches(providedSecret, secret)) {
        throw forbidden();
    }
};

@Controller('internal')
export class InternalController {
    @Public()
    @Post('migrate-roles')
    async migrateRoles(@Headers('x-migrate-secret') providedSecret?: string) {
        assertMigrateSecret(providedSecret);

        const roleIds = await seedSystemRoles();
        const migrated = await migrateUsersToRoleIds(roleIds);

        return { data: { roleIds, migrated } };
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
        const result = await sendInventoryAlertsReport({ force: force === 'true' });
        return { data: result };
    }

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
        const result = await sendMonthlySalesReport(period?.year, period?.month);
        return { data: { sent: true, ...result } };
    }
}
