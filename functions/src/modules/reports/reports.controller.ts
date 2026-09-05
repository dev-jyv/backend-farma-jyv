import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    commissionsQuerySchema,
    deadStockQuerySchema,
    reportPeriodQuerySchema,
} from '../../schemas';
import * as analyticsService from '../../services/analytics.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type ReportPeriodQuery = z.infer<typeof reportPeriodQuerySchema>;
type DeadStockQuery = z.infer<typeof deadStockQuerySchema>;
type CommissionsQuery = z.infer<typeof commissionsQuerySchema>;

/**
 * Reportes de gestión, bajo el área de permiso `dashboard` (hasta ahora sin uso):
 * son cifras agregadas del negocio, no operación de caja ni de inventario.
 */
@Controller('reports')
export class ReportsController {
    @Get('sales-summary')
    @RequirePermission('dashboard', 'read')
    async salesSummary(
        @Query(new ZodValidationPipe(reportPeriodQuerySchema)) query: ReportPeriodQuery,
    ) {
        const data = await analyticsService.getSalesSummary(query);
        return { data };
    }

    /** Utilidad y margen sobre la base sin impuestos. */
    @Get('profit')
    @RequirePermission('dashboard', 'read')
    async profit(
        @Query(new ZodValidationPipe(reportPeriodQuerySchema)) query: ReportPeriodQuery,
    ) {
        const data = await analyticsService.getProfitReport(query);
        return { data };
    }

    @Get('top-products')
    @RequirePermission('dashboard', 'read')
    async topProducts(
        @Query(new ZodValidationPipe(reportPeriodQuerySchema)) query: ReportPeriodQuery,
    ) {
        const data = await analyticsService.getTopProducts(query);
        return { data };
    }

    /** Servicios más cobrados; espejo de `top-products` para la otra rama. */
    @Get('top-services')
    @RequirePermission('dashboard', 'read')
    async topServices(
        @Query(new ZodValidationPipe(reportPeriodQuerySchema)) query: ReportPeriodQuery,
    ) {
        const data = await analyticsService.getTopServices(query);
        return { data };
    }

    /** Comisiones por doctor; con `providerId` se acota a uno solo. */
    @Get('commissions')
    @RequirePermission('dashboard', 'read')
    async commissions(
        @Query(new ZodValidationPipe(commissionsQuerySchema)) query: CommissionsQuery,
    ) {
        const data = await analyticsService.getCommissionsByProvider(query);
        return { data };
    }

    /** Corte de la rama de servicios, con desglose por naturaleza del servicio. */
    @Get('services-summary')
    @RequirePermission('dashboard', 'read')
    async servicesSummary(
        @Query(new ZodValidationPipe(reportPeriodQuerySchema)) query: ReportPeriodQuery,
    ) {
        const data = await analyticsService.getServicesSummary(query);
        return { data };
    }

    @Get('by-cashier')
    @RequirePermission('dashboard', 'read')
    async byCashier(
        @Query(new ZodValidationPipe(reportPeriodQuerySchema)) query: ReportPeriodQuery,
    ) {
        const data = await analyticsService.getSalesByCashier(query);
        return { data };
    }

    /** Productos con existencia y sin salidas en N días (default 90). */
    @Get('dead-stock')
    @RequirePermission('dashboard', 'read')
    async deadStock(
        @Query(new ZodValidationPipe(deadStockQuerySchema)) query: DeadStockQuery,
    ) {
        const data = await analyticsService.getDeadStock(query);
        return { data };
    }
}
