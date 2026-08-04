import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as alertsService from '../src/services/inventory-alerts.service';
import * as countsService from '../src/services/inventory-counts.service';
import * as controlledService from '../src/services/controlled.service';
import * as auditService from '../src/services/audit.service';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import { ControlledGroup } from '../src/types';
import { toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const isoInDays = (days: number): string => {
    const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
};

const createProductFixture = async (overrides: {
    salePrice?: number;
    minStock?: number;
    controlledGroup?: ControlledGroup;
    requiresPrescription?: boolean;
} = {}) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: overrides.salePrice ?? 100,
        minStock: overrides.minStock ?? 0,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        ...(overrides.controlledGroup ? { controlledGroup: overrides.controlledGroup } : {}),
        isActive: true,
        requiresPrescription: overrides.requiresPrescription ?? false,
        suppliers: [],
    });
};

const stockProduct = async (productId: string, quantity: number, expiryDate: string) => {
    const batch = await batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp(expiryDate),
        quantity,
    });
    await productsRepo.updateProduct(productId, { totalStock: quantity });
    return batch;
};

const openSession = async (userId = 'test-cashier') =>
    cashSessionsRepo.createCashSession({
        openedBy: userId,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });

const validPrescription = {
    doctorName: 'Dra. Ana López',
    doctorLicense: '1234567',
    folio: 'REC-001',
};

describe('inventory-alerts.service', () => {
    it('clasifica lotes vencidos y por vencer en la ventana más chica que los cubre',
        async () => {
            const product = await createProductFixture({ minStock: 0 });
            const expired = await stockProduct(product.id, 3, isoInDays(-5));
            const soon = await batchesRepo.createBatch({
                productId: product.id,
                lotNumber: unique('LOTE'),
                expiryDate: toTimestamp(isoInDays(20)),
                quantity: 4,
            });
            const later = await batchesRepo.createBatch({
                productId: product.id,
                lotNumber: unique('LOTE'),
                expiryDate: toTimestamp(isoInDays(75)),
                quantity: 5,
            });
            const farAway = await batchesRepo.createBatch({
                productId: product.id,
                lotNumber: unique('LOTE'),
                expiryDate: toTimestamp(isoInDays(400)),
                quantity: 6,
            });

            const alerts = await alertsService.getInventoryAlerts();
            const ids = (items: Array<{ batchId: string }>) => items.map((item) => item.batchId);

            expect(ids(alerts.expired)).toContain(expired.id);
            expect(ids(alerts.expiring.find((w) => w.windowDays === 30)!.items))
                .toContain(soon.id);
            expect(ids(alerts.expiring.find((w) => w.windowDays === 90)!.items))
                .toContain(later.id);
            // Un lote solo aparece en una ventana, no en las tres.
            expect(ids(alerts.expiring.find((w) => w.windowDays === 60)!.items))
                .not.toContain(soon.id);
            expect(alerts.expiring.flatMap((w) => ids(w.items))).not.toContain(farAway.id);
        });

    it('acepta ventanas personalizadas', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 2, isoInDays(5));

        const alerts = await alertsService.getInventoryAlerts({ expiryWindows: [7] });
        expect(alerts.expiring).toHaveLength(1);
        expect(alerts.expiring[0].windowDays).toBe(7);
        expect(alerts.expiring[0].items.map((item) => item.batchId)).toContain(batch.id);
    });

    it('reporta stock bajo y agotado según minStock', async () => {
        const low = await createProductFixture({ minStock: 5 });
        await stockProduct(low.id, 3, isoInDays(300));
        const empty = await createProductFixture({ minStock: 2 });

        const alerts = await alertsService.getInventoryAlerts();
        expect(alerts.lowStock.map((item) => item.productId)).toContain(low.id);
        expect(alerts.outOfStock.map((item) => item.productId)).toContain(empty.id);
        // Un producto agotado no se cuenta además como stock bajo.
        expect(alerts.lowStock.map((item) => item.productId)).not.toContain(empty.id);
    });

    it('no manda correo cuando no hay nada que reportar', async () => {
        const alerts = await alertsService.getInventoryAlerts();
        const empty = {
            ...alerts,
            expired: [],
            expiring: alerts.expiring.map((window) => ({ ...window, items: [] })),
            lowStock: [],
            outOfStock: [],
            totals: {
                expiredBatches: 0,
                expiredUnits: 0,
                expiringBatches: 0,
                expiringUnits: 0,
                lowStockProducts: 0,
                outOfStockProducts: 0,
            },
        };
        expect(alertsService.hasActionableAlerts(empty)).toBe(false);
    });
});

describe('inventory-counts.service', () => {
    it('ajusta el lote a lo contado con movimiento adjustment_count con signo', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 10, isoInDays(300));

        const count = await countsService.recordInventoryCount({
            items: [{ batchId: batch.id, countedQuantity: 7 }],
            notes: 'Conteo semanal',
            userId: 'manager-user',
            roleSlug: 'manager',
        });

        expect(count.folio).toMatch(/^C-\d{6}$/);
        expect(count.items[0]).toMatchObject({
            expectedQuantity: 10,
            countedQuantity: 7,
            difference: -3,
        });
        expect(count.negativeUnits).toBe(3);
        expect(count.positiveUnits).toBe(0);

        expect((await batchesRepo.getBatchById(batch.id))!.quantity).toBe(7);
        expect((await productsRepo.getProductById(product.id))!.totalStock).toBe(7);

        const movements = await movementsRepo.listStockMovements({ productId: product.id });
        const adjustments = movements.filter((m) => m.type === 'adjustment_count');
        expect(adjustments).toHaveLength(1);
        expect(adjustments[0].quantity).toBe(-3);
        expect(adjustments[0].referenceId).toBe(count.id);
        // No se registra como merma: eso falsearía el reporte de mermas.
        expect(movements.some((m) => m.type === 'exit_waste')).toBe(false);
    });

    it('registra sobrante como diferencia positiva', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 4, isoInDays(300));

        const count = await countsService.recordInventoryCount({
            items: [{ batchId: batch.id, countedQuantity: 6 }],
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(count.positiveUnits).toBe(2);
        expect((await productsRepo.getProductById(product.id))!.totalStock).toBe(6);
    });

    it('deja constancia del lote que cuadró sin generar ajuste', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 5, isoInDays(300));

        const count = await countsService.recordInventoryCount({
            items: [{ batchId: batch.id, countedQuantity: 5 }],
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(count.items[0].difference).toBe(0);
        expect(count.totalDifferenceUnits).toBe(0);
        const movements = await movementsRepo.listStockMovements({ productId: product.id });
        expect(movements.filter((m) => m.type === 'adjustment_count')).toHaveLength(0);
    });

    it('solo admin o gerente pueden ajustar', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 5, isoInDays(300));

        await expect(
            countsService.recordInventoryCount({
                items: [{ batchId: batch.id, countedQuantity: 1 }],
                userId: 'cashier-user',
                roleSlug: 'cashier',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rechaza lotes duplicados y cantidades inválidas', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 5, isoInDays(300));

        await expect(
            countsService.recordInventoryCount({
                items: [
                    { batchId: batch.id, countedQuantity: 1 },
                    { batchId: batch.id, countedQuantity: 2 },
                ],
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

        await expect(
            countsService.recordInventoryCount({
                items: [{ batchId: batch.id, countedQuantity: -1 }],
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('el ajuste queda en la bitácora', async () => {
        const product = await createProductFixture();
        const batch = await stockProduct(product.id, 8, isoInDays(300));

        const count = await countsService.recordInventoryCount({
            items: [{ batchId: batch.id, countedQuantity: 2 }],
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const logs = await auditService.listAuditLogs({ entityId: count.id });
        expect(logs.items).toHaveLength(1);
        expect(logs.items[0]).toMatchObject({
            action: 'inventory.count_adjusted',
            entity: 'inventoryCount',
            userId: 'admin-user',
        });
    });
});

describe('controlled.service - reglas COFEPRIS', () => {
    it('exige receta con folio y retención para el grupo I', async () => {
        const product = await createProductFixture({ controlledGroup: 'I' });
        const session = await openSession();
        await stockProduct(product.id, 5, isoInDays(300));

        const base = {
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash' as const,
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        };

        await expect(salesService.createSale(base)).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('receta médica'),
        });

        await expect(
            salesService.createSale({
                ...base,
                prescription: { doctorName: 'Dra. Ana', doctorLicense: '1234567' },
                prescriptionRetained: true,
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('folio'),
        });

        await expect(
            salesService.createSale({ ...base, prescription: validPrescription }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('retener la receta'),
        });
    });

    it('el grupo IV pide receta pero no folio ni retención', async () => {
        const product = await createProductFixture({ controlledGroup: 'IV' });
        const session = await openSession();
        await stockProduct(product.id, 5, isoInDays(300));

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            prescription: { doctorName: 'Dr. Beto', doctorLicense: '87654321' },
        });

        expect(sale.controlledGroups).toEqual(['IV']);
        expect(sale.prescriptionRetained).toBe(false);
    });

    it('el grupo VI se vende libre', async () => {
        const product = await createProductFixture({ controlledGroup: 'VI' });
        const session = await openSession();
        await stockProduct(product.id, 5, isoInDays(300));

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.prescription).toBeNull();
    });

    it('escribe el libro de control al vender y lo contra-asienta al anular', async () => {
        const product = await createProductFixture({ controlledGroup: 'II' });
        const session = await openSession();
        await stockProduct(product.id, 5, isoInDays(300));

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            prescription: validPrescription,
            prescriptionRetained: true,
        });

        const afterSale = await controlledService.listControlledLedger({ saleId: sale.id });
        expect(afterSale.items).toHaveLength(1);
        expect(afterSale.items[0]).toMatchObject({
            type: 'sale',
            controlledGroup: 'II',
            quantity: 2,
            prescriptionRetained: true,
            saleFolio: sale.folio,
        });
        expect(afterSale.items[0].lotNumbers).toHaveLength(1);
        expect(afterSale.items[0].prescription).toMatchObject({ folio: 'REC-001' });

        await salesService.voidSale(sale.id, 'admin-user', 'admin');

        const afterVoid = await controlledService.listControlledLedger({ saleId: sale.id });
        expect(afterVoid.items).toHaveLength(2);
        expect(afterVoid.items[1]).toMatchObject({ type: 'void', quantity: -2 });
        // El libro no se borra: se contra-asienta y la suma queda en cero.
        expect(afterVoid.items.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(0);
    });

    it('contra-asienta el libro en una devolución parcial', async () => {
        const product = await createProductFixture({ controlledGroup: 'III' });
        const session = await openSession();
        await stockProduct(product.id, 5, isoInDays(300));

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 3 }],
            paymentMethod: 'cash',
            amountReceived: 300,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            prescription: validPrescription,
            prescriptionRetained: true,
        });

        const saleReturn = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Devolución',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const ledger = await controlledService.listControlledLedger({ saleId: sale.id });
        const returnEntry = ledger.items.find((entry) => entry.type === 'return');
        expect(returnEntry).toMatchObject({ quantity: -1, referenceFolio: saleReturn.folio });
        expect(ledger.items.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(2);
    });

    it('un producto sin grupo no escribe libro de control', async () => {
        const product = await createProductFixture();
        const session = await openSession();
        await stockProduct(product.id, 2, isoInDays(300));

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        const ledger = await controlledService.listControlledLedger({ saleId: sale.id });
        expect(ledger.items).toHaveLength(0);
    });

    it('respeta el flag heredado requiresPrescription cuando no hay grupo', async () => {
        const product = await createProductFixture({ requiresPrescription: true });
        const session = await openSession();
        await stockProduct(product.id, 2, isoInDays(300));

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 100,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('receta médica'),
        });
    });
});

describe('audit.service - bitácora', () => {
    it('audita el cambio de precio con valores antes y después', async () => {
        const product = await createProductFixture({ salePrice: 100 });

        await productsService.updateProduct(
            product.id,
            { salePrice: 150 },
            { userId: 'manager-user', roleSlug: 'manager' },
        );

        const logs = await auditService.listAuditLogs({ entityId: product.id });
        const priceLog = logs.items.find((log) => log.action === 'product.price_changed');
        expect(priceLog).toBeDefined();
        expect(priceLog!.changes).toMatchObject({
            salePrice: { before: 100, after: 150 },
        });
        expect(priceLog!.userId).toBe('manager-user');
    });

    it('no escribe bitácora si el PATCH no cambió nada vigilado', async () => {
        const product = await createProductFixture({ salePrice: 80 });
        await productsService.updateProduct(
            product.id,
            { salePrice: 80 },
            { userId: 'manager-user', roleSlug: 'manager' },
        );

        const logs = await auditService.listAuditLogs({ entityId: product.id });
        expect(logs.items.filter((log) => log.action !== 'product.created')).toHaveLength(0);
    });

    it('audita el descuento por encima del tope y la anulación', async () => {
        const product = await createProductFixture({ salePrice: 100 });
        const session = await openSession();
        await stockProduct(product.id, 5, isoInDays(300));

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2, discountAmount: 60 }],
            paymentMethod: 'cash',
            amountReceived: 140,
            cashSessionId: session.id,
            cashierId: 'admin-user',
            roleSlug: 'admin',
        });

        const afterSale = await auditService.listAuditLogs({ entityId: sale.id });
        expect(afterSale.items.map((log) => log.action)).toContain('sale.discount_override');

        await salesService.voidSale(sale.id, 'admin-user', 'admin');
        const afterVoid = await auditService.listAuditLogs({ entityId: sale.id });
        expect(afterVoid.items.map((log) => log.action)).toContain('sale.voided');
    });

    it('audita el corte de caja con diferencia', async () => {
        const session = await openSession(unique('cajero'));

        await cashSessionsService.closeSession(session.id, session.openedBy, 'admin', 25);

        const logs = await auditService.listAuditLogs({ entityId: session.id });
        expect(logs.items).toHaveLength(1);
        expect(logs.items[0]).toMatchObject({
            action: 'cash_session.closed_with_difference',
            entity: 'cashSession',
        });
        expect(logs.items[0].metadata).toMatchObject({ cashDifference: 25 });
    });

    it('un corte que cuadra no escribe bitácora', async () => {
        const session = await openSession(unique('cajero'));
        await cashSessionsService.closeSession(session.id, session.openedBy, 'admin', 0);

        const logs = await auditService.listAuditLogs({ entityId: session.id });
        expect(logs.items).toHaveLength(0);
    });

    it('filtra la bitácora por acción y entidad', async () => {
        const product = await createProductFixture({ salePrice: 10 });
        await productsService.deleteProduct(product.id, { userId: 'admin-user' });

        const byEntity = await auditService.listAuditLogs({ entityId: product.id });
        expect(byEntity.items.map((log) => log.action)).toContain('product.deactivated');

        const filtered = await auditService.listAuditLogs({
            entityId: product.id,
            action: 'product.deactivated',
        });
        expect(filtered.items).toHaveLength(1);
    });
});
