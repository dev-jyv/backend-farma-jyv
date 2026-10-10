import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as cashMovementsRepo from '../src/repositories/cash-movements.repository';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as salesService from '../src/services/sales.service';
import {
    buildDailyReport,
    buildMonthlyReport,
    REPORTS_TIME_ZONE,
} from '../src/services/sales-reports.service';
import { toTimestamp } from '../src/utils/firestore';
import { toCents } from '../src/utils/taxes';

/**
 * Reporte diario y mensual: separación farmacia / consultorio y desglose de gastos.
 *
 * El emulador es **compartido y serial**: otras suites dejan ventas y gastos en el
 * mismo día que estos reportes leen. Por eso todo se mide por **delta** (reporte
 * antes / después del hecho bajo prueba), que es lo único exacto que se puede
 * afirmar sobre un agregado global.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const ACTOR = { userId: 'test-admin' };

const isoDayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORTS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
});

/** Hoy en hora de México, que es la ventana que arma `buildDailyReport`. */
const hoy = (): string => isoDayFormatter.format(new Date());

const mesActual = (): { year: number; month: number } => {
    const [year, month] = hoy().split('-').map(Number);
    return { year, month };
};

const crearProducto = async (salePrice = 100) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice,
        minStock: 0,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: false,
        suppliers: [],
    });
};

const surtir = async (productId: string, quantity: number) => {
    await batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-06-01'),
        quantity,
        costPrice: 40,
    });
    await productsRepo.updateProduct(productId, { totalStock: quantity });
};

const crearServicio = (price = 250) =>
    pharmacyServicesService.createPharmacyService({
        code: unique('SRV'),
        name: unique('Servicio'),
        serviceType: 'consultation',
        price,
        taxMode: 'exempt',
        hasIeps: false,
        commissionRate: 40,
        requiresPerformer: false,
    } as Parameters<typeof pharmacyServicesService.createPharmacyService>[0], ACTOR);

const abrirTurno = (openedBy: string) =>
    cashSessionsRepo.createCashSession({
        openedBy,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
    });

describe('buildDailyReport - farmacia, consultorio y gastos', () => {
    it('separa la mercancía del servicio cobrados en la misma venta', async () => {
        const producto = await crearProducto(100);
        const servicio = await crearServicio(250);
        await surtir(producto.id, 5);
        const cajero = unique('cajero');
        const turno = await abrirTurno(cajero);

        const antes = await buildDailyReport(hoy());

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 2 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 450,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const despues = await buildDailyReport(hoy());

        // 200 de mercancía + 250 de servicio en una sola venta.
        expect(toCents(despues.branches.pharmacy.total - antes.branches.pharmacy.total))
            .toBe(toCents(200));
        expect(toCents(despues.branches.services.total - antes.branches.services.total))
            .toBe(toCents(250));
        // La venta mixta cuenta una vez en cada rama.
        expect(despues.branches.pharmacy.salesCount - antes.branches.pharmacy.salesCount)
            .toBe(1);
        expect(despues.branches.services.salesCount - antes.branches.services.salesCount)
            .toBe(1);
        // Comisión del prestador: 40 % de 250.
        expect(toCents(
            despues.branches.services.commissionTotal - antes.branches.services.commissionTotal,
        )).toBe(toCents(100));
        // Las participaciones se reparten el 100 %.
        expect(despues.branches.pharmacy.share + despues.branches.services.share)
            .toBeCloseTo(100, 1);
    });

    it('desglosa los gastos por categoría y los resta del resultado', async () => {
        const cajero = unique('cajero');
        const turno = await abrirTurno(cajero);

        const antes = await buildDailyReport(hoy());

        await cashMovementsRepo.createMovement({
            cashSessionId: turno.id,
            type: 'expense',
            amount: 300,
            reason: 'Pago de nómina',
            category: 'salary',
            createdBy: cajero,
            createdByLabel: 'Cajero de prueba',
        });
        await cashMovementsRepo.createMovement({
            cashSessionId: turno.id,
            type: 'expense',
            amount: 120.5,
            reason: 'Compra de bolsas',
            category: 'supplies',
            description: 'Bolsas y cinta',
            createdBy: cajero,
        });
        // Un retiro NO es gasto: mueve efectivo entre cajón y bóveda.
        await cashMovementsRepo.createMovement({
            cashSessionId: turno.id,
            type: 'withdrawal',
            amount: 900,
            reason: 'Traslado a bóveda',
            createdBy: cajero,
        });

        const despues = await buildDailyReport(hoy());

        expect(toCents(despues.expenses.total - antes.expenses.total)).toBe(toCents(420.5));
        expect(despues.expenses.count - antes.expenses.count).toBe(2);

        const nomina = despues.expenses.byCategory.find((row) => row.category === 'salary');
        expect(nomina?.label).toBe('Nómina');
        expect(nomina!.amount).toBeGreaterThanOrEqual(300);

        // El retiro no aparece en ninguna categoría de gasto.
        const gastado = despues.expenses.byCategory
            .reduce((sum, row) => sum + toCents(row.amount), 0);
        expect(gastado).toBe(toCents(despues.expenses.total));

        // Resultado = vendido − devuelto − gastado.
        expect(toCents(despues.netResult)).toBe(
            toCents(despues.totals.totalAmount)
            - toCents(despues.refundTotal)
            - toCents(despues.expenses.total),
        );

        // El detalle del día trae el concepto y quién lo registró.
        const detalle = despues.expenseRows.find((row) => row.reason === 'Pago de nómina');
        expect(detalle).toMatchObject({
            categoryLabel: 'Nómina',
            createdByLabel: 'Cajero de prueba',
            amount: 300,
        });
        expect(detalle!.time).toMatch(/^\d{2}:\d{2}$/);
    });

    it('las participaciones y el ticket promedio son consistentes', async () => {
        const reporte = await buildDailyReport(hoy());

        if (reporte.totals.salesCount > 0) {
            expect(toCents(reporte.ticketAverage)).toBe(
                Math.round(toCents(reporte.totals.totalAmount) / reporte.totals.salesCount),
            );
        } else {
            expect(reporte.ticketAverage).toBe(0);
        }
    });
});

describe('buildMonthlyReport - top 10 y comparativo', () => {
    it('lista cuando mucho 10 productos, ordenados por importe', async () => {
        const cajero = unique('cajero');
        const turno = await abrirTurno(cajero);

        // 12 productos con importes decrecientes: el reporte debe cortar en 10.
        for (let index = 0; index < 12; index += 1) {
            const producto = await crearProducto(100 + index * 10);
            await surtir(producto.id, 3);
            await salesService.createSale({
                items: [{ productId: producto.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 500,
                cashSessionId: turno.id,
                cashierId: cajero,
            });
        }

        const { year, month } = mesActual();
        const reporte = await buildMonthlyReport(year, month);

        expect(reporte.topProducts).toHaveLength(10);
        const importes = reporte.topProducts.map((product) => product.amount);
        expect([...importes].sort((a, b) => b - a)).toEqual(importes);
    });

    it('incluye ramas, gastos, mejor día y comparativo del mes anterior', async () => {
        const { year, month } = mesActual();
        const reporte = await buildMonthlyReport(year, month);

        expect(reporte.branches.pharmacy.total).toBeGreaterThan(0);
        expect(reporte.expenses.total).toBeGreaterThan(0);
        expect(reporte.expenses.byCategory.length).toBeGreaterThan(0);

        // El mejor día es el de mayor importe entre los días con ventas.
        const maximo = Math.max(...reporte.byDay.map((day) => day.amount));
        expect(reporte.bestDay!.amount).toBe(maximo);

        // Promedio sobre días CON ventas, no sobre los 30 del calendario.
        expect(toCents(reporte.dailyAverage)).toBe(
            Math.round(toCents(reporte.totals.totalAmount) / reporte.byDay.length),
        );

        // Sin ventas el mes pasado en el emulador: no hay porcentaje que inventar.
        expect(reporte.previousMonth.periodLabel).toEqual(expect.any(String));
        expect(reporte.previousMonth.total).toBe(0);
        expect(reporte.previousMonth.changeRate).toBeNull();
    });

    it('el top de servicios no mezcla mercancía', async () => {
        const servicio = await crearServicio(300);
        const producto = await crearProducto(150);
        await surtir(producto.id, 2);
        const cajero = unique('cajero');
        const turno = await abrirTurno(cajero);

        await salesService.createSale({
            items: [
                { kind: 'service', serviceId: servicio.id, quantity: 2 },
                { productId: producto.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 800,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const { year, month } = mesActual();
        const reporte = await buildMonthlyReport(year, month);

        const renglon = reporte.topServices.find((row) => row.serviceId === servicio.id);
        expect(renglon).toMatchObject({ quantity: 2, amount: 600 });
        expect(reporte.topServices.map((row) => row.name))
            .not.toContain(producto.name);
        expect(reporte.topProducts.map((row) => row.name))
            .not.toContain(servicio.name);
    });
});
