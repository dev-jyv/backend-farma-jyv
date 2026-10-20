import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as dailyStatsRepo from '../src/repositories/daily-stats.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as dailyStatsService from '../src/services/daily-stats.service';
import * as dashboardCharts from '../src/services/dashboard-charts.service';
import * as salesReports from '../src/services/sales-reports.service';
import * as salesService from '../src/services/sales.service';
import { toTimestamp } from '../src/utils/firestore';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const sellOne = async (price: number) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Prod'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: price,
        minStock: 1,
        totalStock: 5,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: false,
        suppliers: [],
    });
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2027-06-01'),
        quantity: 5,
    });
    const session = await cashSessionsRepo.createCashSession({
        openedBy: 'test-cashier',
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });
    return salesService.createSale({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        amountReceived: price,
        cashSessionId: session.id,
        cashierId: 'test-cashier',
    });
};

const today = () => dailyStatsRepo.statsDayOf(new Date());
const todayStats = async () =>
    (await dailyStatsRepo.listDailyStats('0000-01-01', '9999-12-31')).find(
        (day) => day.ymd === today(),
    );

describe('dailyStats', () => {
    afterEach(() => {
        delete process.env.DASHBOARD_SALES_FROM_STATS;
    });

    it('las ventas suman al día y la anulación resta, siempre fiel a las ventas', async () => {
        const first = await sellOne(10);
        await sellOne(25);

        expect(await todayStats()).toMatchObject({
            salesTotalCents: toCentsOf(first.total) + 2500,
            salesCount: 2,
        });

        await salesService.voidSale(first.id, 'admin-user');

        expect(await todayStats()).toMatchObject({ salesTotalCents: 2500, salesCount: 1 });
        expect(await dailyStatsService.diffDailyStats()).toEqual([]);
    });

    it('detecta un día corrupto y el rebuild lo corrige', async () => {
        await sellOne(10);
        await dailyStatsRepo.setDay({ ymd: today(), salesTotalCents: 1, salesCount: 99 });
        await dailyStatsRepo.setDay({ ymd: '2020-01-01', salesTotalCents: 500, salesCount: 1 });

        const diffs = await dailyStatsService.diffDailyStats();
        expect(diffs.map((diff) => diff.ymd)).toEqual(['2020-01-01', today()]);

        expect(await dailyStatsService.rebuildDailyStats()).toBe(2);
        expect(await dailyStatsService.diffDailyStats()).toEqual([]);
    });

    it('el job de comparación registra una alerta con el día afectado', async () => {
        await sellOne(10);
        expect(await dailyStatsService.diffRecentDailyStats(7)).toEqual([]);

        await dailyStatsRepo.setDay({ ymd: today(), salesTotalCents: 1, salesCount: 99 });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const diffs = await dailyStatsService.checkDailyStatsIntegrity(7);
            expect(diffs.map((diff) => diff.ymd)).toEqual([today()]);
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(String(errorSpy.mock.calls[0][0])).toContain(today());
        } finally {
            errorSpy.mockRestore();
            await dailyStatsService.rebuildDailyStats();
        }
    });

    it('el total del mes anterior del reporte mensual sale de dailyStats', async () => {
        await dailyStatsRepo.setDay({ ymd: '2031-03-10', salesTotalCents: 12345, salesCount: 3 });
        await dailyStatsRepo.setDay({ ymd: '2031-03-31', salesTotalCents: 1000, salesCount: 1 });
        await dailyStatsRepo.setDay({ ymd: '2031-04-01', salesTotalCents: 99999, salesCount: 1 });
        const report = await salesReports.buildMonthlyReport(2031, 4);
        expect(report.previousMonth.total).toBe(133.45);
        await dailyStatsService.rebuildDailyStats();
    });

    it('la serie del tablero desde dailyStats coincide con la de las ventas', async () => {
        await sellOne(10);
        const voided = await sellOne(40);
        await sellOne(15);
        await salesService.voidSale(voided.id, 'admin-user');

        for (const granularity of ['day', 'month', 'year'] as const) {
            delete process.env.DASHBOARD_SALES_FROM_STATS;
            const fromSales = await dashboardCharts.getDashboardCharts({ granularity });
            process.env.DASHBOARD_SALES_FROM_STATS = 'true';
            const fromStats = await dashboardCharts.getDashboardCharts({ granularity });

            expect(fromStats.sales).toEqual(fromSales.sales);
            expect(fromStats.sales.count).toBeGreaterThanOrEqual(2);
        }
    });
});

function toCentsOf(amount: number): number {
    return Math.round(amount * 100);
}
