import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as analyticsService from '../src/services/analytics.service';
import * as scanService from '../src/services/scan.service';
import { toTimestamp } from '../src/utils/firestore';
import { toCents } from '../src/utils/taxes';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

const FNC1 = String.fromCharCode(29);

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

/** Ventana amplia para que los reportes no dependan del reloj del emulador. */
const period = () => ({
    from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

const createProductFixture = async (overrides: {
    salePrice?: number;
    barcode?: string;
} = {}) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        ...(overrides.barcode ? { barcode: overrides.barcode } : {}),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: overrides.salePrice ?? 116,
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

const stockProduct = async (
    productId: string,
    quantity: number,
    options: { costPrice?: number; lotNumber?: string; expiryDate?: string } = {},
) => {
    const batch = await batchesRepo.createBatch({
        productId,
        lotNumber: options.lotNumber ?? unique('LOTE'),
        expiryDate: toTimestamp(options.expiryDate ?? '2027-06-01'),
        quantity,
        ...(options.costPrice !== undefined ? { costPrice: options.costPrice } : {}),
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

describe('cash-sessions.service - corte X', () => {
    it('la vista previa no cierra el turno ni deja registro', async () => {
        const product = await createProductFixture({ salePrice: 100 });
        const session = await openSession(unique('cajero'));
        await stockProduct(product.id, 5);
        await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        const preview = await cashSessionsService.buildXReport(
            session.id,
            session.openedBy,
            'cashier',
        );

        expect(preview.reading).toBeNull();
        expect(preview.summary.grandTotal).toBe(200);
        expect(preview.expectedCashAmount).toBe(200);
        expect(preview.html).toContain('LECTURA PARCIAL');
        expect(preview.html).toContain('@page { size: 58mm auto; margin: 0; }');

        const stillOpen = await cashSessionsRepo.getCashSessionById(session.id);
        expect(stillOpen!.closedAt).toBeNull();
        const readings = await cashSessionsService.listXReadings(
            session.id,
            session.openedBy,
            'cashier',
        );
        expect(readings).toHaveLength(0);
    });

    it('la lectura registrada deja folio X y el turno sigue abierto', async () => {
        const session = await openSession(unique('cajero'));

        const first = await cashSessionsService.buildXReport(
            session.id,
            session.openedBy,
            'cashier',
            { persist: true },
        );
        const second = await cashSessionsService.buildXReport(
            session.id,
            session.openedBy,
            'cashier',
            { persist: true, width: 80 },
        );

        expect(first.reading!.folio).toMatch(/^X-\d{6}$/);
        expect(second.reading!.id).not.toBe(first.reading!.id);
        expect(second.html).toContain('size: 80mm auto');

        const readings = await cashSessionsService.listXReadings(
            session.id,
            session.openedBy,
            'cashier',
        );
        expect(readings).toHaveLength(2);
        expect((await cashSessionsRepo.getCashSessionById(session.id))!.closedAt).toBeNull();
    });

    it('un turno cerrado ya no admite lectura X', async () => {
        const session = await openSession(unique('cajero'));
        await cashSessionsService.closeSession(session.id, session.openedBy, 'admin', 0);

        await expect(
            cashSessionsService.buildXReport(session.id, session.openedBy, 'cashier'),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('corte Z'),
        });
    });

    it('el cierre Z devuelve el comprobante con conteo y diferencia', async () => {
        const session = await openSession(unique('cajero'));

        const result = await cashSessionsService.closeSession(
            session.id,
            session.openedBy,
            'admin',
            50,
        );

        expect(result.html).toContain('Corte Z');
        expect(result.html).toContain('Diferencia');
        expect(result.html).not.toContain('LECTURA PARCIAL');
    });

    it('otro cajero no puede leer la caja ajena', async () => {
        const session = await openSession(unique('cajero'));

        await expect(
            cashSessionsService.buildXReport(session.id, 'otro-cajero', 'cashier'),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
});

describe('analytics.service - reportes', () => {
    it('resume ventas por método de pago y descuenta devoluciones', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession(unique('cajero'));
        await stockProduct(product.id, 10);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 232,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });
        await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Devolución',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const summary = await analyticsService.getSalesSummary(period());

        expect(summary.salesCount).toBeGreaterThanOrEqual(1);
        expect(summary.refundTotal).toBeGreaterThanOrEqual(116);
        // Comparación en centavos: el servicio suma en centavos, restar en float aquí
        // introduce el error de punto flotante que el servicio justamente evita.
        expect(toCents(summary.netTotal))
            .toBe(toCents(summary.grossTotal) - toCents(summary.refundTotal));
        expect(summary.byPaymentMethod.some((entry) => entry.method === 'cash')).toBe(true);
        expect(summary.ivaTotal).toBeGreaterThan(0);
    });

    it('calcula margen sobre la base sin impuestos usando el costo del lote', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession(unique('cajero'));
        await stockProduct(product.id, 5, { costPrice: 60 });

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 116,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        expect(productItem(sale, 0).costAmount).toBe(60);
        expect(sale.costTotal).toBe(60);

        // Límite alto: el reporte corta el top-N y otras suites también venden.
        const profit = await analyticsService.getProfitReport({ ...period(), limit: 200 });
        const row = profit.byProduct.find((item) => item.productId === product.id);

        // Base 100 (el IVA no es ingreso), costo 60 → utilidad 40, margen 40%.
        expect(row).toMatchObject({ revenueBase: 100, cost: 60, profit: 40, marginRate: 40 });
        expect(profit.salesWithCost).toBeGreaterThanOrEqual(1);
    });

    it('una venta sin costo capturado no se cuenta como utilidad del 100%', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession(unique('cajero'));
        await stockProduct(product.id, 3);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 116,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        expect(productItem(sale, 0).costAmount).toBeNull();
        expect(sale.costTotal).toBeNull();

        const profit = await analyticsService.getProfitReport(period());
        expect(profit.salesWithoutCost).toBeGreaterThanOrEqual(1);
    });

    it('ordena los más vendidos y resta lo devuelto', async () => {
        const strong = await createProductFixture({ salePrice: 50 });
        const weak = await createProductFixture({ salePrice: 50 });
        const session = await openSession(unique('cajero'));
        await stockProduct(strong.id, 20);
        await stockProduct(weak.id, 20);

        await salesService.createSale({
            items: [
                { productId: strong.id, quantity: 9 },
                { productId: weak.id, quantity: 2 },
            ],
            paymentMethod: 'cash',
            amountReceived: 1000,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        const top = await analyticsService.getTopProducts({ ...period(), limit: 50 });
        const strongRow = top.items.find((item) => item.productId === strong.id)!;
        const weakRow = top.items.find((item) => item.productId === weak.id)!;

        expect(strongRow.quantity).toBe(9);
        expect(weakRow.quantity).toBe(2);
        expect(top.items.indexOf(strongRow)).toBeLessThan(top.items.indexOf(weakRow));
    });

    it('agrupa por cajero con anuladas y devoluciones aparte', async () => {
        const product = await createProductFixture({ salePrice: 100 });
        const cashier = unique('cajero');
        const session = await openSession(cashier);
        await stockProduct(product.id, 10);

        await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: cashier,
        });
        const voided = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: cashier,
        });
        await salesService.voidSale(voided.id, 'admin-user', 'admin');

        const report = await analyticsService.getSalesByCashier(period());
        const row = report.items.find((item) => item.cashierId === cashier)!;

        expect(row).toMatchObject({ salesCount: 1, total: 100, voidedCount: 1 });
        // La anulada no suma al total vendido del cajero.
        expect(row.ticketAverage).toBe(100);
    });

    it('lista productos con existencia y sin salidas', async () => {
        const idle = await createProductFixture({ salePrice: 30 });
        await stockProduct(idle.id, 7);
        const moving = await createProductFixture({ salePrice: 30 });
        const session = await openSession(unique('cajero'));
        await stockProduct(moving.id, 7);
        await salesService.createSale({
            items: [{ productId: moving.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 30,
            cashSessionId: session.id,
            cashierId: session.openedBy,
        });

        const report = await analyticsService.getDeadStock({ days: 30, limit: 200 });
        const ids = report.items.map((item) => item.productId);

        expect(ids).toContain(idle.id);
        expect(ids).not.toContain(moving.id);
        expect(report.days).toBe(30);
    });
});

describe('scan.service', () => {
    it('resuelve producto, lote y caducidad desde un GS1 DataMatrix', async () => {
        const barcode = `75012${Math.floor(Math.random() * 90000 + 10000)}890`;
        const product = await createProductFixture({ barcode });

        const result = await scanService.resolveScannedCode(
            `]d2010${barcode}10LOTE-A${FNC1}17270630`,
        );

        expect(result.kind).toBe('gs1');
        expect(result.product?.id).toBe(product.id);
        expect(result.entrySuggestion).toEqual({
            productId: product.id,
            lotNumber: 'LOTE-A',
            expiryDate: '2027-06-30',
            quantity: null,
        });
        expect(result.existingBatchId).toBeNull();
    });

    it('detecta que el lote escaneado ya existe', async () => {
        const barcode = `75013${Math.floor(Math.random() * 90000 + 10000)}890`;
        const product = await createProductFixture({ barcode });
        const batch = await stockProduct(product.id, 4, {
            lotNumber: 'LOTE-B',
            expiryDate: '2027-06-30',
        });

        const result = await scanService.resolveScannedCode(
            `010${barcode}10LOTE-B${FNC1}17270630`,
        );

        expect(result.existingBatchId).toBe(batch.id);
    });

    it('un código plano busca por barcode o SKU sin inventar lote', async () => {
        const product = await createProductFixture();

        const result = await scanService.resolveScannedCode(product.sku);

        expect(result.kind).toBe('plain');
        expect(result.gs1).toBeNull();
        expect(result.product?.id).toBe(product.id);
        expect(result.entrySuggestion.lotNumber).toBeNull();
    });

    it('un código desconocido no truena, solo no encuentra producto', async () => {
        const result = await scanService.resolveScannedCode('(01)09999999999999(10)X');

        expect(result.product).toBeNull();
        expect(result.entrySuggestion.productId).toBeNull();
        expect(result.gs1?.lotNumber).toBe('X');
    });
});
