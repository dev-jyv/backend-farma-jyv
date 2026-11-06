import { Timestamp } from 'firebase-admin/firestore';
import { renderToStaticMarkup } from 'react-dom/server';
import { SalesReportEmail } from '../src/emails/sales-report.email';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as returnsRepo from '../src/repositories/sale-returns.repository';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as productsService from '../src/services/products.service';
import * as saleReturnsService from '../src/services/sale-returns.service';
import * as salesReportsService from '../src/services/sales-reports.service';
import * as salesService from '../src/services/sales.service';
import { db, toTimestamp } from '../src/utils/firestore';
import { APP_TIME_ZONE, getZonedYmd } from '../src/utils/timezone';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 52 — la venta offline ya cobrada se registra aunque falte stock, el
 * producto esté inactivo o el turno ya esté cerrado, marcada para revisión. En
 * línea los rechazos siguen igual: el cajero tiene al cliente enfrente.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const CASHIER = 'cajero-52';
const ADMIN = { userId: 'admin-52', roleSlug: 'admin' };
const PRESCRIPTION = { doctorName: 'Dra. Ruiz', doctorLicense: '1234567' };
const HOUR_MS = 60 * 60 * 1000;

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
});

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

const addBatch = (productId: string, quantity: number, expiry = '2030-01-01') =>
    batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp(expiry),
        quantity,
        costPrice: 8,
    });

const productWithStock = async (stock: number, overrides: Record<string, unknown> = {}) => {
    const product = await createProduct(overrides);
    const batch = await addBatch(product.id, stock);
    await productsRepo.updateProduct(product.id, { totalStock: stock });
    return { product, batch };
};

/** Turno abierto hace dos horas: los `soldAt` de las pruebas caen dentro. */
const openSession = async () => {
    const ref = await db().collection('cashSessions').add({
        openedBy: CASHIER,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
        openedAt: Timestamp.fromMillis(Date.now() - 2 * HOUR_MS),
    });
    return { id: ref.id };
};

const sell = (
    productId: string,
    sessionId: string,
    quantity: number,
    extra: Record<string, unknown> = {},
) => salesService.createSale({
    items: [{ productId, quantity, unitPrice: 20 }],
    paymentMethod: 'cash',
    amountReceived: 20 * quantity,
    cashSessionId: sessionId,
    cashierId: CASHIER,
    ...extra,
});

const batchQty = async (batchId: string) =>
    (await db().collection('batches').doc(batchId).get()).data()?.quantity as number;

const auditsOf = async (saleId: string, action: string) =>
    (await db().collection('auditLogs')
        .where('entityId', '==', saleId)
        .where('action', '==', action)
        .get()).docs.map((doc) => doc.data());

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

describe('SPEC 52 — faltante de stock', () => {
    it('offline: '
        + '5 piezas con stock 3 se registra, el lote queda en 0 y el faltante es 2', async () => {
        const { product, batch } = await productWithStock(3, { controlledGroup: 'IV' });
        const session = await openSession();

        const sale = await sell(product.id, session.id, 5, {
            offline: true,
            prescription: PRESCRIPTION,
        });

        const item = productItem(sale);
        expect(item.quantity).toBe(5);
        expect(item.batchAllocations).toEqual([{ batchId: batch.id, quantity: 3 }]);
        expect(item.stockShortfall).toBe(2);
        // Sin costo de las piezas faltantes: entra a "sin costo", no a margen inflado.
        expect(item.costAmount).toBeNull();
        expect(sale.costTotal).toBeNull();
        expect(sale.stockReview).toEqual({
            items: [{ productId: product.id, requested: 5, allocated: 3, shortfall: 2 }],
        });
        expect(await batchQty(batch.id)).toBe(0);
        expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(0);

        const audits = await auditsOf(sale.id, 'sale.stock_shortfall');
        expect(audits).toHaveLength(1);
        expect(audits[0].metadata.items).toEqual(sale.stockReview!.items);

        // El libro registra la cantidad completa: la salida física ocurrió.
        const ledger = (await db().collection('controlledSalesLedger')
            .where('saleId', '==', sale.id).get()).docs.map((doc) => doc.data());
        expect(ledger.map((row) => row.quantity)).toEqual([5]);

        // Los movimientos solo llevan lo que salió de lotes.
        const movements = (await db().collection('stockMovements')
            .where('referenceId', '==', sale.id).get()).docs.map((doc) => doc.data());
        expect(movements.map((row) => row.quantity)).toEqual([3]);

        const stored = await salesService.getSale(sale.id);
        expect(stored.stockReview).toEqual(sale.stockReview);
    });

    it('en línea la misma venta responde 400 STOCK_INSUFFICIENT', async () => {
        const { product, batch } = await productWithStock(3);
        const session = await openSession();

        await expect(sell(product.id, session.id, 5)).rejects.toMatchObject({
            statusCode: 400,
            syncCode: 'STOCK_INSUFFICIENT',
        });
        expect(await batchQty(batch.id)).toBe(3);
    });

    it('ticket de varias partidas con una sin stock: '
        + 'las demás se descuentan completas', async () => {
        const full = await productWithStock(10);
        const empty = await productWithStock(0);
        const session = await openSession();

        const sale = await salesService.createSale({
            items: [
                { productId: full.product.id, quantity: 4, unitPrice: 20 },
                { productId: empty.product.id, quantity: 2, unitPrice: 20 },
            ],
            paymentMethod: 'cash',
            amountReceived: 120,
            cashSessionId: session.id,
            cashierId: CASHIER,
            offline: true,
        });

        expect(productItem(sale, 0).stockShortfall).toBeUndefined();
        expect(productItem(sale, 1).batchAllocations).toEqual([]);
        expect(productItem(sale, 1).stockShortfall).toBe(2);
        expect(await batchQty(full.batch.id)).toBe(6);
        expect(await batchQty(empty.batch.id)).toBe(0);
        expect(sale.stockReview?.items).toEqual([
            { productId: empty.product.id, requested: 2, allocated: 0, shortfall: 2 },
        ]);
    });

    it('dos ventas offline del último frasco: '
        + 'las dos se registran, la segunda con faltante 1', async () => {
        const { product, batch } = await productWithStock(1);
        const session = await openSession();

        const first = await sell(product.id, session.id, 1, { offline: true });
        const second = await sell(product.id, session.id, 1, { offline: true });

        expect(productItem(first).stockShortfall).toBeUndefined();
        expect(productItem(second).stockShortfall).toBe(1);
        expect(await batchQty(batch.id)).toBe(0);
        expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(0);
    });

    it('reintento idempotente de una venta con faltante: '
        + 'la misma venta, una sola bitácora', async () => {
        const { product } = await productWithStock(1);
        const session = await openSession();
        const idempotencyKey = unique('k');

        const first = await sell(product.id, session.id, 3, { offline: true, idempotencyKey });
        const again = await sell(product.id, session.id, 3, { offline: true, idempotencyKey });

        expect(again.id).toBe(first.id);
        expect(again.stockReview).toEqual(first.stockReview);
        expect(await auditsOf(first.id, 'sale.stock_shortfall')).toHaveLength(1);
    });

    it('anular una venta con faltante devuelve solo lo que salió de lotes', async () => {
        const { product, batch } = await productWithStock(2);
        const session = await openSession();
        const sale = await sell(product.id, session.id, 5, { offline: true });

        await salesService.voidSale(sale.id, CASHIER, 'admin');

        expect(await batchQty(batch.id)).toBe(2);
        expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(2);
    });
});

describe('SPEC 52 — catálogo inactivo', () => {
    it('offline: un producto inactivo se vende y queda con catalogReview', async () => {
        const { product, batch } = await productWithStock(5);
        await productsRepo.updateProduct(product.id, { isActive: false });
        const session = await openSession();

        await expect(sell(product.id, session.id, 1)).rejects.toMatchObject({
            syncCode: 'PRODUCT_INACTIVE',
        });

        const sale = await sell(product.id, session.id, 1, { offline: true });
        expect(sale.catalogReview).toEqual({ inactive: [product.id] });
        expect(await batchQty(batch.id)).toBe(4);
        expect(await auditsOf(sale.id, 'sale.catalog_review')).toHaveLength(1);
    });

    it('offline: un servicio inactivo se cobra y queda con catalogReview', async () => {
        const service = await pharmacyServicesService.createPharmacyService({
            code: unique('SRV'),
            name: unique('Consulta'),
            serviceType: 'consultation',
            price: 100,
            taxMode: 'exempt',
            hasIeps: false,
            commissionRate: 0,
            requiresPerformer: false,
        } as Parameters<typeof pharmacyServicesService.createPharmacyService>[0], ADMIN);
        await db().collection('pharmacyServices').doc(service.id).update({ isActive: false });
        const session = await openSession();

        const sale = await salesService.createSale({
            items: [{ kind: 'service', serviceId: service.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: CASHIER,
            offline: true,
        });

        expect(sale.catalogReview).toEqual({ inactive: [service.id] });
    });

    it('un producto que no existe sigue siendo PRODUCT_NOT_FOUND aun offline', async () => {
        const session = await openSession();
        await expect(sell('no-existe', session.id, 1, { offline: true })).rejects.toMatchObject({
            syncCode: 'PRODUCT_NOT_FOUND',
        });
    });
});

describe('SPEC 52 — turno cerrado', () => {
    const closeAt = async (sessionId: string, closedAt: Date, extra = {}) =>
        db().collection('cashSessions').doc(sessionId).update({
            closedAt: Timestamp.fromDate(closedAt),
            closedBy: CASHIER,
            hasPendingAdjustment: false,
            adjustmentStatus: null,
            ...extra,
        });

    it('venta offline cobrada antes del cierre: '
        + 'lateSync y ajuste pendiente en el turno', async () => {
        const { product } = await productWithStock(10);
        const session = await openSession();
        await closeAt(session.id, new Date(Date.now() - 30 * 60 * 1000), {
            hasPendingAdjustment: false,
            adjustmentStatus: 'approved',
        });

        const first = await sell(product.id, session.id, 2, {
            offline: true,
            soldAt: minutesAgo(60),
        });
        const second = await sell(product.id, session.id, 1, {
            offline: true,
            soldAt: minutesAgo(45),
        });

        expect(first.lateSync).toBe(true);
        expect(second.lateSync).toBe(true);
        expect(first.cashSessionId).toBe(session.id);
        const stored = await cashSessionsRepo.getCashSessionById(session.id);
        expect(stored?.hasPendingAdjustment).toBe(true);
        // Ajuste ya aprobado: vuelve a pedir revisión.
        expect(stored?.adjustmentStatus).toBe('pending');
        expect(stored?.lateSales).toEqual({ count: 2, cashTotal: 60 });
        expect(await auditsOf(first.id, 'sale.late_sync')).toHaveLength(1);

        const late = await salesService.listSales({ review: 'late' });
        expect(late.items.map((sale) => sale.id).sort()).toEqual([first.id, second.id].sort());
    });

    it('cobrada después del cierre, sin soldAt confiable o en línea: SESSION_CLOSED', async () => {
        const { product } = await productWithStock(10);
        const session = await openSession();
        await closeAt(session.id, new Date(Date.now() - 30 * 60 * 1000));

        await expect(sell(product.id, session.id, 1, {
            offline: true,
            soldAt: minutesAgo(10),
        })).rejects.toMatchObject({ syncCode: 'SESSION_CLOSED' });
        // Sin `soldAt` la fecha de negocio es la recepción, posterior al cierre.
        await expect(sell(product.id, session.id, 1, { offline: true }))
            .rejects.toMatchObject({ syncCode: 'SESSION_CLOSED' });
        await expect(sell(product.id, session.id, 1))
            .rejects.toMatchObject({ syncCode: 'SESSION_CLOSED' });
        expect((await cashSessionsRepo.getCashSessionById(session.id))?.lateSales)
            .toBeUndefined();
    });
});

describe('SPEC 52 — cierre y devoluciones consistentes', () => {
    it('una venta que confirma entre el cálculo del resumen y el cierre '
        + 'aparece en el corte', async () => {
        const { product } = await productWithStock(10);
        const session = await openSession();
        await sell(product.id, session.id, 1);

        // La lectura previa al cierre (devoluciones) deja entrar otra venta.
        const original = returnsRepo.listReturnsForSession;
        jest.spyOn(returnsRepo, 'listReturnsForSession').mockImplementation(async (id) => {
            await sell(product.id, session.id, 2);
            return original(id);
        });

        const { summary, session: closed } = await cashSessionsService.closeSession(
            session.id,
            CASHIER,
            'cashier',
            60,
        );

        expect(summary.salesCount).toBe(2);
        expect(summary.grandTotal).toBe(60);
        expect(closed.expectedCashAmount).toBe(60);
        expect(closed.cashDifference).toBe(0);
        expect(closed.summary?.salesCount).toBe(2);
    });

    it('createSaleReturn revisa closedAt dentro de su transacción', async () => {
        const { product, batch } = await productWithStock(10);
        const session = await openSession();
        const sale = await sell(product.id, session.id, 2);

        // El turno se cierra después de la revisión previa y antes de la transacción.
        const original = returnsRepo.listReturnsForSale;
        jest.spyOn(returnsRepo, 'listReturnsForSale').mockImplementation(async (id) => {
            await db().collection('cashSessions').doc(session.id).update({
                closedAt: Timestamp.now(),
            });
            return original(id);
        });

        await expect(saleReturnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Prueba',
            refundMethod: 'cash',
            cashSessionId: session.id,
            userId: CASHIER,
            roleSlug: 'admin',
        })).rejects.toMatchObject({ message: 'El turno de caja ya está cerrado' });
        expect(await batchQty(batch.id)).toBe(8);
        expect((await db().collection('saleReturns').get()).empty).toBe(true);
    });
});

describe('SPEC 52 — marcas de revisión en el historial y el correo diario', () => {
    it('GET /sales?review=stock|catalog filtra por marca y el correo lista '
        + 'conteo y folios', async () => {
        const short = await productWithStock(1);
        const inactive = await productWithStock(5);
        await productsRepo.updateProduct(inactive.product.id, { isActive: false });
        const normal = await productWithStock(5);
        const session = await openSession();

        const shortSale = await sell(short.product.id, session.id, 2, { offline: true });
        const inactiveSale = await sell(inactive.product.id, session.id, 1, { offline: true });
        const normalSale = await sell(normal.product.id, session.id, 1, { offline: true });

        // Por turno: el archivo comparte base y otras pruebas también dejan marcas.
        const ids = async (review: 'stock' | 'catalog' | 'late') =>
            (await salesService.listSales({
                review,
                cashSessionId: session.id,
                requesterId: CASHIER,
            })).items.map((sale) => sale.id);
        expect(await ids('stock')).toEqual([shortSale.id]);
        expect(await ids('catalog')).toEqual([inactiveSale.id]);
        expect(await ids('late')).toEqual([]);
        expect(await ids('stock')).not.toContain(normalSale.id);

        const today = getZonedYmd(Date.now(), APP_TIME_ZONE);
        const report = await salesReportsService.buildDailyReport(today);
        const { stock, catalog } = report.saleReview;
        expect(stock.folios).toContain(shortSale.folio);
        expect(stock.folios).not.toContain(normalSale.folio);
        expect(stock.count).toBe(stock.folios.length);
        expect(catalog.folios).toContain(inactiveSale.folio);
        expect(catalog.folios).not.toContain(shortSale.folio);
        const total = stock.count + catalog.count + report.saleReview.late.count;
        const html = renderToStaticMarkup(SalesReportEmail({ report }));
        expect(html).toContain(`Ventas sin conexión por revisar (${total})`);
        expect(html).toContain(`Con faltante de stock (${stock.count}): `);
        expect(html).toContain(shortSale.folio);
        expect(html).toContain(`Con producto o servicio inactivo (${catalog.count}): `);
        expect(html).toContain(inactiveSale.folio);
    });
});

describe('SPEC 52 — invariante de lotes', () => {
    it('ninguna cantidad de lote quedó negativa en las pruebas del archivo', async () => {
        const batches = await db().collection('batches').get();
        expect(batches.size).toBeGreaterThan(0);
        expect(batches.docs.filter((doc) => (doc.data().quantity as number) < 0)).toEqual([]);
    });
});
