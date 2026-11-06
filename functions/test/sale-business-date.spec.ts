import { Timestamp } from 'firebase-admin/firestore';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import * as dailyStatsService from '../src/services/daily-stats.service';
import * as productsService from '../src/services/products.service';
import * as salesReportsService from '../src/services/sales-reports.service';
import * as salesService from '../src/services/sales.service';
import { SalesController } from '../src/modules/sales/sales.controller';
import { AuthUser } from '../src/types';
import { db, toTimestamp } from '../src/utils/firestore';
import { APP_TIME_ZONE, getZonedYmd } from '../src/utils/timezone';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 51 — la venta offline se registra con la hora en que se cobró
 * (`businessAt`), no con la de llegada al servidor (`createdAt`): reportes,
 * `dailyStats`, libro de controlados, movimientos y FEFO.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const CASHIER = 'cajero-51';
const DAY_MS = 24 * 60 * 60 * 1000;
const PRESCRIPTION = { doctorName: 'Dra. Ruiz', doctorLicense: '1234567' };

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
});

const ymdOf = (ms: number) => getZonedYmd(ms, APP_TIME_ZONE);
/** México no tiene horario de verano desde 2022: UTC−6 todo el año. */
const mxIso = (ymd: string, time: string) => `${ymd}T${time}-06:00`;

const createProduct = (overrides: Record<string, unknown> = {}) =>
    productsService.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 20,
        minStock: 1,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        ...overrides,
    } as Parameters<typeof productsService.createProduct>[0]);

const addBatch = (productId: string, quantity: number, expiry: string) =>
    batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp(expiry),
        quantity,
        costPrice: 8,
    });

/** Turno abierto a la hora indicada (las ventas offline se miden contra ella). */
const openSessionAt = async (openedAt: Date) => {
    const ref = await db().collection('cashSessions').add({
        openedBy: CASHIER,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
        openedAt: Timestamp.fromDate(openedAt),
    });
    return { id: ref.id };
};

const sell = (
    productId: string,
    sessionId: string,
    extra: Record<string, unknown> = {},
) => salesService.createSale({
    items: [{ productId, quantity: 1, unitPrice: 20 }],
    paymentMethod: 'cash',
    amountReceived: 20,
    cashSessionId: sessionId,
    cashierId: CASHIER,
    ...extra,
});

const auditsOf = async (saleId: string, action: string) =>
    (await db().collection('auditLogs')
        .where('entityId', '==', saleId)
        .where('action', '==', action)
        .get()).docs.map((doc) => doc.data());

describe('SPEC 51 — fecha de cobro como fecha de negocio', () => {
    const nowMs = Date.now();
    const yesterday = ymdOf(nowMs - DAY_MS);
    const today = ymdOf(nowMs);
    const soldAt = mxIso(yesterday, '23:50:00');

    it('venta offline de ayer 23:50: '
        + 'reporte diario, dailyStats, libro y movimientos de ayer', async () => {
        const product = await createProduct({ controlledGroup: 'IV' });
        await addBatch(product.id, 10, '2030-01-01');
        const session = await openSessionAt(new Date(Date.parse(soldAt) - 60 * 60 * 1000));

        const sale = await sell(product.id, session.id, {
            offline: true,
            soldAt,
            prescription: PRESCRIPTION,
        });

        expect(sale.soldAtTrusted).toBe(true);
        expect(sale.businessAt?.toMillis()).toBe(Date.parse(soldAt));
        expect(sale.soldAt?.toMillis()).toBe(Date.parse(soldAt));
        // `createdAt` sigue siendo la recepción.
        expect(ymdOf(sale.createdAt.toMillis())).toBe(today);

        const stored = await salesRepo.getSaleById(sale.id);
        expect(stored?.businessAt?.toMillis()).toBe(Date.parse(soldAt));
        expect(stored?.soldAtTrusted).toBe(true);

        const daily = await salesReportsService.buildDailyReport(yesterday);
        expect(daily.sales.map((row) => row.folio)).toContain(sale.folio);
        expect(daily.sales.find((row) => row.folio === sale.folio)?.time).toBe('23:50');
        const todayReport = await salesReportsService.buildDailyReport(today);
        expect(todayReport.sales.map((row) => row.folio)).not.toContain(sale.folio);

        const stats = (await db().collection('dailyStats').doc(yesterday).get()).data();
        expect(stats).toMatchObject({ salesCount: 1, salesTotalCents: 2000 });
        expect((await db().collection('dailyStats').doc(today).get()).exists).toBe(false);
        // El chequeo de integridad cuenta por la misma fecha: sin falsa alarma.
        expect(await dailyStatsService.diffRecentDailyStats(7)).toEqual([]);

        const ledger = (await db().collection('controlledSalesLedger')
            .where('saleId', '==', sale.id).get()).docs.map((doc) => doc.data());
        expect(ledger).toHaveLength(1);
        expect(ledger[0].createdAt.toMillis()).toBe(Date.parse(soldAt));
        expect(ymdOf(ledger[0].recordedAt.toMillis())).toBe(today);

        const movements = (await db().collection('stockMovements')
            .where('referenceId', '==', sale.id).get()).docs.map((doc) => doc.data());
        expect(movements).toHaveLength(1);
        expect(movements[0].createdAt.toMillis()).toBe(Date.parse(soldAt));
        expect(movements[0].recordedAt.toMillis()).toBe(sale.createdAt.toMillis());

        // `products.updatedAt` y `batches.updatedAt` siguen en la hora del servidor.
        const fresh = await productsRepo.getProductById(product.id);
        expect(fresh?.updatedAt.toMillis()).toBe(sale.createdAt.toMillis());
    });

    it('un lote que caducó hoy a las 00:00 no impide registrar la venta de ayer', async () => {
        const product = await createProduct();
        // La caducidad se guarda como medianoche UTC del día: vendible todo ayer.
        const batch = await addBatch(product.id, 5, `${yesterday}T00:00:00.000Z`);
        const session = await openSessionAt(new Date(Date.parse(soldAt) - 60 * 60 * 1000));

        // En línea (hoy) el lote ya está caducado.
        await expect(sell(product.id, session.id)).rejects.toMatchObject({
            statusCode: 400,
            syncCode: 'BATCH_EXPIRED',
        });

        const sale = await sell(product.id, session.id, { offline: true, soldAt });
        expect(productItem(sale).batchAllocations).toEqual([{ batchId: batch.id, quantity: 1 }]);
        expect(productItem(sale).stockShortfall).toBeUndefined();
    });

    it('soldAt anterior a la apertura del turno: no confiable y auditado', async () => {
        const product = await createProduct();
        await addBatch(product.id, 5, '2030-01-01');
        const session = await openSessionAt(new Date(Date.parse(soldAt) + 60 * 60 * 1000));

        const sale = await sell(product.id, session.id, { offline: true, soldAt });

        expect(sale.soldAtTrusted).toBe(false);
        expect(sale.soldAt?.toMillis()).toBe(Date.parse(soldAt));
        expect(sale.businessAt?.toMillis()).toBe(sale.createdAt.toMillis());
        const audits = await auditsOf(sale.id, 'sale.sold_at_untrusted');
        expect(audits).toHaveLength(1);
        expect(audits[0].metadata).toMatchObject({ reason: 'before_session', soldAt });
        // Con la fecha de recepción, la venta es de hoy.
        expect((await db().collection('dailyStats').doc(today).get()).data())
            .toMatchObject({ salesCount: 1 });
    });

    it('soldAt de más de 7 días: no confiable y auditado', async () => {
        const product = await createProduct();
        await addBatch(product.id, 5, '2030-01-01');
        const oldSoldAt = new Date(nowMs - 8 * DAY_MS).toISOString();
        const session = await openSessionAt(new Date(nowMs - 9 * DAY_MS));

        const sale = await sell(product.id, session.id, { offline: true, soldAt: oldSoldAt });

        expect(sale.soldAtTrusted).toBe(false);
        expect(sale.businessAt?.toMillis()).toBe(sale.createdAt.toMillis());
        const audits = await auditsOf(sale.id, 'sale.sold_at_untrusted');
        expect(audits.map((audit) => audit.metadata.reason)).toEqual(['too_old']);
    });

    it('venta offline sin soldAt (POS viejo) y en línea: businessAt = createdAt', async () => {
        const product = await createProduct();
        await addBatch(product.id, 5, '2030-01-01');
        const session = await openSessionAt(new Date(nowMs - 2 * DAY_MS));

        const offline = await sell(product.id, session.id, { offline: true });
        expect(offline.businessAt?.toMillis()).toBe(offline.createdAt.toMillis());
        expect(offline.soldAt).toBeNull();
        expect(offline.soldAtTrusted).toBe(false);

        // En línea el `soldAt` no cuenta (non-goal): la fecha de negocio es la de recepción.
        const online = await sell(product.id, session.id, { soldAt });
        expect(online.businessAt?.toMillis()).toBe(online.createdAt.toMillis());
        expect(online.soldAt).toBeNull();
        expect(await auditsOf(online.id, 'sale.sold_at_untrusted')).toEqual([]);
    });

    it('anular una venta offline resta del dailyStats del día del cobro', async () => {
        const product = await createProduct();
        await addBatch(product.id, 5, '2030-01-01');
        const session = await openSessionAt(new Date(Date.parse(soldAt) - 60 * 60 * 1000));
        const sale = await sell(product.id, session.id, { offline: true, soldAt });
        const statsOf = async (ymd: string) =>
            (await db().collection('dailyStats').doc(ymd).get()).data() ??
                { salesCount: 0, salesTotalCents: 0 };
        const [beforeYesterday, beforeToday] = [await statsOf(yesterday), await statsOf(today)];

        await salesService.voidSale(sale.id, CASHIER, 'admin');

        const [afterYesterday, afterToday] = [await statsOf(yesterday), await statsOf(today)];
        expect(afterYesterday.salesCount).toBe(beforeYesterday.salesCount - 1);
        expect(afterYesterday.salesTotalCents).toBe(beforeYesterday.salesTotalCents - 2000);
        expect(afterToday).toEqual(beforeToday);
    });

    it('reportes con ventas viejas sin businessAt: cuentan por createdAt', async () => {
        const createdAt = toTimestamp(mxIso(yesterday, '12:00:00'));
        const ref = await db().collection('sales').add({
            folio: unique('V'),
            items: [],
            subtotal: 50,
            discountTotal: 0,
            total: 50,
            paymentMethod: 'cash',
            amountReceived: 50,
            change: 0,
            cashSessionId: null,
            cashierId: CASHIER,
            voidedAt: null,
            voidedBy: null,
            createdAt,
        });

        const { items } = await salesRepo.listSales({
            from: mxIso(yesterday, '00:00:00'),
            to: mxIso(yesterday, '23:59:59.999'),
            byBusinessDate: true,
        });
        const legacy = items.find((item) => item.id === ref.id);
        expect(legacy?.businessAt?.toMillis()).toBe(createdAt.toMillis());
        expect(legacy?.soldAt).toBeNull();
        expect(legacy?.soldAtTrusted).toBe(false);
    });

    it('la respuesta HTTP lleva businessAt en ISO', async () => {
        const product = await createProduct();
        await addBatch(product.id, 5, '2030-01-01');
        const session = await openSessionAt(new Date(Date.parse(soldAt) - 60 * 60 * 1000));
        const user = { uid: CASHIER, role: { slug: 'cashier' } } as unknown as AuthUser;

        const { data } = await new SalesController().bulkCreate({
            items: [{
                idempotencyKey: unique('k'),
                items: [{ productId: product.id, quantity: 1, unitPrice: 20 }],
                paymentMethod: 'cash',
                amountReceived: 20,
                cashSessionId: session.id,
                soldAt,
            }],
        } as unknown as Parameters<SalesController['bulkCreate']>[0], user);

        expect(data[0]).toMatchObject({ ok: true });
        const sale = (data[0] as { sale: { businessAt: string; soldAt: string } }).sale;
        expect(sale.businessAt).toBe(new Date(soldAt).toISOString());
        expect(sale.soldAt).toBe(new Date(soldAt).toISOString());
    });

    it('venta de controlados del 30 que llega el 1: libro de noviembre y bitácora', async () => {
        // "Ahora" del servidor: 1 de diciembre 00:30 en México.
        const serverNow = Timestamp.fromDate(new Date('2026-12-01T06:30:00Z'));
        jest.spyOn(Timestamp, 'now').mockReturnValue(serverNow);
        const lateSoldAt = '2026-11-30T23:50:00-06:00';
        const product = await createProduct({ controlledGroup: 'IV' });
        await addBatch(product.id, 5, '2030-01-01');
        const session = await openSessionAt(new Date('2026-11-30T20:00:00-06:00'));

        const sale = await sell(product.id, session.id, {
            offline: true,
            soldAt: lateSoldAt,
            prescription: PRESCRIPTION,
        });

        expect(sale.businessAt?.toMillis()).toBe(Date.parse(lateSoldAt));
        const ledger = (await db().collection('controlledSalesLedger')
            .where('saleId', '==', sale.id).get()).docs.map((doc) => doc.data());
        expect(ymdOf(ledger[0].createdAt.toMillis())).toBe('2026-11-30');
        const audits = await auditsOf(sale.id, 'sale.late_ledger_entry');
        expect(audits).toHaveLength(1);
        expect(audits[0].summary).toContain('2026-11');
    });
});
