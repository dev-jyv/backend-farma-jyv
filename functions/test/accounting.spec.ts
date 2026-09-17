import * as accountingService from '../src/services/accounting.service';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as inventoryService from '../src/services/inventory.service';
import * as productsRepo from '../src/repositories/products.repository';
import * as returnsService from '../src/services/sale-returns.service';
import * as salesService from '../src/services/sales.service';
import { toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

/** Ventana amplia, para no depender del reloj del emulador. */
const period = () => ({
    from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

const createProductFixture = async (salePrice = 116) => {
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

const stockProduct = async (productId: string, quantity: number, costPrice?: number) => {
    const batch = await batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2027-06-01'),
        quantity,
        ...(costPrice !== undefined ? { costPrice } : {}),
    });
    await productsRepo.updateProduct(productId, { totalStock: quantity });
    return batch;
};

const openSession = async (userId = unique('cajero')) =>
    cashSessionsRepo.createCashSession({
        openedBy: userId,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });

describe('accounting.service - estado de resultados', () => {
    it('mide el ingreso sobre la base sin impuestos, no sobre lo cobrado', async () => {
        const product = await createProductFixture(116);
        const session = await openSession();
        await stockProduct(product.id, 5, 50);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 116,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        // Periodo del ancho de esta venta: el emulador es compartido entre
        // suites, así que una ventana de horas traería las ventas de las otras
        // y la cifra exacta dejaría de ser comprobable.
        const instant = sale.createdAt.toDate().toISOString();
        const statement = await accountingService.getIncomeStatement({
            from: instant,
            to: instant,
        });

        // 116 cobrados = 100 de base + 16 de IVA. El IVA no es ingreso: es del
        // fisco, y contarlo como tal inflaría la utilidad en un 16 %.
        expect(statement.revenue.pharmacy).toBeCloseTo(100, 2);
        expect(statement.taxes.ivaCharged).toBeCloseTo(16, 2);
        expect(statement.costOfSales.merchandise).toBeCloseTo(50, 2);
        expect(statement.grossProfit).toBeCloseTo(50, 2);
        expect(statement.reliability.salesWithCost).toBe(1);
    });

    it('la devolución baja el ingreso y devuelve su costo al inventario', async () => {
        const product = await createProductFixture(116);
        const session = await openSession();
        await stockProduct(product.id, 5, 50);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 232,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        const saleReturn = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Devolución',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        // Ventana del ancho exacto de la venta y su devolución; ver la prueba
        // anterior sobre por qué no se usa un rango de horas.
        const statement = await accountingService.getIncomeStatement({
            from: sale.createdAt.toDate().toISOString(),
            to: saleReturn.createdAt.toDate().toISOString(),
        });

        // Dos piezas a 116 = 200 de base y 100 de costo; vuelve una.
        expect(statement.revenue.pharmacy).toBeCloseTo(200, 2);
        expect(statement.revenue.returns).toBeCloseTo(100, 2);
        expect(statement.revenue.net).toBeCloseTo(100, 2);
        // El costo baja a la mitad: la pieza volvió al anaquel. Si solo bajara
        // el ingreso, cada devolución se leería como una pérdida de su costo.
        expect(statement.costOfSales.merchandise).toBeCloseTo(50, 2);
        expect(statement.grossProfit).toBeCloseTo(50, 2);
    });

    it('la merma entra al costo de ventas valuada al costo del lote', async () => {
        const product = await createProductFixture(116);
        const batch = await stockProduct(product.id, 10, 30);

        const { movement } = await inventoryService.recordExit({
            productId: product.id,
            batchId: batch.id,
            quantity: 2,
            reason: 'waste',
            userId: 'admin-user',
        });

        const instant = movement.createdAt.toDate().toISOString();
        const statement = await accountingService.getIncomeStatement({
            from: instant,
            to: instant,
        });

        // 2 piezas a 30 de costo. El movimiento guarda cantidad y lote, no
        // importe: si el costo no se leyera del lote, la merma saldría en cero.
        expect(statement.costOfSales.waste).toBeCloseTo(60, 2);
    });
});

describe('accounting.service - gastos fuera de caja', () => {
    it('se registra sin turno y no toca el efectivo esperado del corte', async () => {
        const session = await openSession();

        const movement = await accountingService.createExpense(
            'admin-user',
            'admin',
            'Admin',
            {
                amount: 8000,
                reason: 'Renta de marzo',
                category: 'rent',
                paymentMethod: 'transfer',
            },
        );

        expect(movement.cashSessionId).toBeNull();
        expect(movement.paymentMethod).toBe('transfer');

        // El corte filtra por sesión, así que un gasto sin turno queda fuera solo:
        // capturar la nómina aquí no puede descuadrarle la caja a nadie.
        const summary = await cashSessionsService.getSessionSummary(
            session.id,
            session.openedBy,
            'admin',
        );
        expect(summary.expectedCashAmount).toBe(0);
        expect(summary.summary.movements.expenses.total).toBe(0);
    });

    it('suma al estado de resultados en su categoría', async () => {
        // Instante propio en el pasado, con desplazamiento aleatorio: el
        // emulador es compartido entre suites, y una ventana de segundos a 45
        // días atrás solo puede contener el gasto de esta prueba.
        const occurredAt = new Date(
            Date.now() - 45 * 24 * 60 * 60 * 1000 - Math.floor(Math.random() * 86_400_000),
        );

        await accountingService.createExpense('admin-user', 'admin', 'Admin', {
            amount: 1500,
            reason: 'Nómina quincena',
            category: 'salary',
            paymentMethod: 'transfer',
            occurredAt: occurredAt.toISOString(),
        });

        const statement = await accountingService.getIncomeStatement({
            from: new Date(occurredAt.getTime() - 2_000).toISOString(),
            to: new Date(occurredAt.getTime() + 2_000).toISOString(),
        });
        const line = statement.operatingExpenses.byCategory
            .find((item) => item.category === 'salary');

        expect(line).toBeDefined();
        expect(line!.total).toBeCloseTo(1500, 2);
        // Pagado por transferencia: no salió del cajón, y el desglose tiene que
        // decirlo o nadie podría cuadrar el informe contra los cortes.
        expect(line!.outsideCashBox).toBeCloseTo(1500, 2);
        expect(line!.fromCashBox).toBeCloseTo(0, 2);
        expect(statement.operatingExpenses.total).toBeCloseTo(1500, 2);
        expect(statement.reliability.expensesOutsideCashBox).toBe(1);
    });

    it('un gasto con fecha anterior cae en su periodo, no en el de captura', async () => {
        const occurredAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

        await accountingService.createExpense('admin-user', 'admin', 'Admin', {
            amount: 2400,
            reason: unique('Luz del mes pasado'),
            category: 'electricity',
            paymentMethod: 'transfer',
            occurredAt: occurredAt.toISOString(),
        });

        // Periodo que contiene la ocurrencia pero NO el instante de captura.
        const past = await accountingService.getIncomeStatement({
            from: new Date(occurredAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
            to: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        });
        const pastLine = past.operatingExpenses.byCategory
            .find((line) => line.category === 'electricity');

        expect(pastLine).toBeDefined();
        expect(pastLine!.total).toBeGreaterThanOrEqual(2400);

        // Y no aparece en el periodo de hoy: cargarlo al mes equivocado deforma
        // los dos estados de resultados a la vez.
        const today = await accountingService.getIncomeStatement(period());
        const todayLine = today.operatingExpenses.byCategory
            .find((line) => line.category === 'electricity');
        expect(todayLine?.total ?? 0).toBeLessThan(2400);
    });

    it('rechaza corregir un gasto que cuelga de un turno de caja', async () => {
        const session = await openSession();
        const movement = await cashSessionsService.addMovement(
            session.id,
            session.openedBy,
            'cashier',
            {
                type: 'expense',
                amount: 100,
                reason: 'Garrafón',
                category: 'supplies',
                description: 'Agua',
            },
        );

        await expect(
            accountingService.updateExpense(movement.id, 'admin-user', 'admin', { amount: 120 }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('punto de venta'),
        });
    });

    it('exige descripción en las categorías que no se explican con el motivo', async () => {
        await expect(
            accountingService.createExpense('admin-user', 'admin', 'Admin', {
                amount: 300,
                reason: 'Compra',
                category: 'supplies',
                paymentMethod: 'card',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('accounting.service - posición financiera', () => {
    it('valúa el inventario a costo y declara los lotes que no puede valuar', async () => {
        const withCost = await createProductFixture();
        const withoutCost = await createProductFixture();
        await stockProduct(withCost.id, 4, 25);
        await stockProduct(withoutCost.id, 3);

        const position = await accountingService.getFinancialPosition();

        expect(position.inventory.total).toBeGreaterThanOrEqual(100);
        expect(position.inventory.batchesWithoutCost).toBeGreaterThanOrEqual(1);
        // La lista de faltantes viaja en la respuesta: la pantalla tiene que
        // poder decir por qué esto no es un balance general.
        const conceptos = position.missing.map((item) => item.concept);
        expect(conceptos).toEqual(
            expect.arrayContaining(['Bancos', 'Capital contable', 'Saldos iniciales']),
        );
        // Cuentas por pagar ya se calcula: si volviera a la lista de faltantes,
        // la pantalla estaría pidiendo algo que el sistema ya tiene.
        expect(conceptos).not.toContain('Cuentas por pagar');
        expect(position.payables.total).toBeGreaterThanOrEqual(0);
    });
});
