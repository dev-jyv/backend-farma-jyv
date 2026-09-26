import 'reflect-metadata';
import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import * as promotionsRepo from '../src/repositories/promotions.repository';
import * as promotionsService from '../src/services/promotions.service';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import { runPromotionsMaintenance } from '../src/services/promotions-maintenance.service';
import { sendPromotionsMaintenanceReport } from '../src/services/promotion-alerts-sender.service';
import { sendReportEmail } from '../src/services/email.service';
import { buildDailyReport, REPORTS_TIME_ZONE } from '../src/services/sales-reports.service';
import { PromotionsController } from '../src/modules/promotions/promotions.controller';
import { expiringSuggestionsQuerySchema } from '../src/schemas';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

// Ningún correo sale de las pruebas: se revisa qué se habría mandado.
jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

const sendMock = sendReportEmail as jest.MockedFunction<typeof sendReportEmail>;

/**
 * Lo que se construye encima de las promociones: desempeño, sugerencias por
 * caducidad, reemplazo, mantenimiento diario, avisos por correo y ventas por
 * revisar en el reporte. Contra el emulador; el cálculo puro del desempeño se
 * prueba aparte en `promotion-performance.spec.ts`.
 */

const DAY = 24 * 60 * 60 * 1000;
const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };

const createProduct = async (options: {
    salePrice?: number;
    isActive?: boolean;
    batches?: Array<{ daysToExpiry: number; quantity: number; costPrice?: number }>;
} = {}) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'caja',
        salePrice: options.salePrice ?? 35,
        minStock: 1,
        totalStock: 0,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        isActive: options.isActive ?? true,
        suppliers: [],
    });
    const batches = options.batches ?? [{ daysToExpiry: 800, quantity: 50, costPrice: 10 }];
    let total = 0;
    for (const batch of batches) {
        // Media jornada extra: `Math.ceil` de días no cae justo en el borde.
        await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: unique('LOTE'),
            expiryDate: Timestamp.fromMillis(Date.now() + batch.daysToExpiry * DAY - DAY / 2),
            quantity: batch.quantity,
            costPrice: batch.costPrice ?? 10,
        });
        total += batch.quantity;
    }
    await productsRepo.updateProduct(product.id, { totalStock: total });
    return { ...product, totalStock: total };
};

const openSession = () => cashSessionsRepo.createCashSession({
    openedBy: 'test-cashier',
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const tieredPromo = (productIds: string[], name = 'Paracetamol 2x$60') =>
    promotionsService.createPromotion({
        name,
        rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
        productIds,
    }, ADMIN);

const sell = (input: {
    productId: string;
    sessionId: string;
    quantity: number;
    promotionId?: string;
    discountAmount?: number;
    offline?: boolean;
}) => salesService.createSale({
    items: [{
        productId: input.productId,
        quantity: input.quantity,
        unitPrice: 35,
        discountAmount: input.discountAmount ?? 0,
        ...(input.promotionId ? { promotionId: input.promotionId } : {}),
    }],
    paymentMethod: 'cash',
    amountReceived: 1000,
    cashSessionId: input.sessionId,
    cashierId: 'test-cashier',
    offline: input.offline,
});

const expectAppError = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ code });
};

beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue(undefined);
});

describe('promociones: desempeño y operación', () => {
    describe('GET /promotions/:id/performance', () => {
        it('cuenta la promo contra la ventana previa, sin anuladas', async () => {
            const product = await createProduct();
            const promo = await tieredPromo([product.id]);
            const startsAtMs = Date.now() - 10 * DAY;
            await db().collection('promotions').doc(promo.id).update({
                startsAt: Timestamp.fromMillis(startsAtMs),
            });
            const session = await openSession();

            await sell({ productId: product.id, sessionId: session.id, quantity: 2,
                promotionId: promo.id, discountAmount: 10 });
            await sell({ productId: product.id, sessionId: session.id, quantity: 4,
                promotionId: promo.id, discountAmount: 20 });
            const anulada = await sell({ productId: product.id, sessionId: session.id,
                quantity: 2, promotionId: promo.id, discountAmount: 10 });
            await db().collection('sales').doc(anulada.id).update({
                voidedAt: Timestamp.now(),
                voidedBy: 'admin-user',
            });
            // Base: 3 piezas dentro de la ventana previa (10 días antes del
            // inicio) y 5 fuera de ella.
            const base = await sell({ productId: product.id, sessionId: session.id, quantity: 3 });
            await db().collection('sales').doc(base.id).update({
                createdAt: Timestamp.fromMillis(startsAtMs - 5 * DAY),
            });
            const vieja = await sell({ productId: product.id, sessionId: session.id, quantity: 5 });
            await db().collection('sales').doc(vieja.id).update({
                createdAt: Timestamp.fromMillis(startsAtMs - 15 * DAY),
            });
            // Venta normal durante la promo: no es de la promo ni de la base.
            await sell({ productId: product.id, sessionId: session.id, quantity: 1 });

            const performance = await promotionsService.getPromotionPerformance(promo.id);
            expect(performance).toMatchObject({
                promotionId: promo.id,
                name: promo.name,
                endsAt: null,
                daysActive: 10,
                salesCount: 2,
                unitsSold: 6,
                discountTotal: 30,
                netRevenue: 180,
                costTotal: 60,
                grossProfit: 120,
                unitsPerDayDuring: 0.6,
                baseline: { days: 10, unitsSold: 3, unitsPerDay: 0.3 },
                liftPercent: 100,
                byProduct: [{
                    productId: product.id,
                    productName: product.name,
                    unitsSold: 6,
                    discountTotal: 30,
                    netRevenue: 180,
                }],
            });
            expect(performance.startsAt).toBe(new Date(startsAtMs).toISOString());
            expect(Date.parse(performance.effectiveEnd)).toBeLessThanOrEqual(Date.now());
        });

        it('más de 30 productos: la base se consulta por bloques y no duplica', async () => {
            const products = await Promise.all(
                Array.from({ length: 31 }, () => createProduct({ batches: [] })),
            );
            const [first, last] = [products[0], products[30]];
            await Promise.all([first, last].map((product) => batchesRepo.createBatch({
                productId: product.id,
                lotNumber: unique('LOTE'),
                expiryDate: toTimestamp('2029-01-01'),
                quantity: 20,
                costPrice: 10,
            }).then(() => productsRepo.updateProduct(product.id, { totalStock: 20 }))));
            const promo = await tieredPromo(products.map((product) => product.id), 'Muchos');
            const startsAtMs = Date.now() - 4 * DAY;
            await db().collection('promotions').doc(promo.id).update({
                startsAt: Timestamp.fromMillis(startsAtMs),
            });
            const session = await openSession();
            // Una venta con productos del primer y del segundo bloque.
            const mixta = await salesService.createSale({
                items: [
                    { productId: first.id, quantity: 1, unitPrice: 35, discountAmount: 0 },
                    { productId: last.id, quantity: 2, unitPrice: 35, discountAmount: 0 },
                ],
                paymentMethod: 'cash',
                amountReceived: 200,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            });
            await db().collection('sales').doc(mixta.id).update({
                createdAt: Timestamp.fromMillis(startsAtMs - DAY),
            });

            const performance = await promotionsService.getPromotionPerformance(promo.id);
            expect(performance.baseline.unitsSold).toBe(3);
        });

        it('404 si la promoción no existe', async () => {
            await expectAppError(promotionsService.getPromotionPerformance('no-existe'),
                'NOT_FOUND');
        });
    });

    describe('GET /promotions/suggestions/expiring', () => {
        it('lotes por caducar con % por cercanía, sin vencidos ni inactivos', async () => {
            const cercano = await createProduct({ batches: [
                { daysToExpiry: 10, quantity: 4 },
                { daysToExpiry: 45, quantity: 6 },
            ] });
            const lejano = await createProduct({ batches: [{ daysToExpiry: 80, quantity: 7 }] });
            const fuera = await createProduct({ batches: [{ daysToExpiry: 120, quantity: 3 }] });
            const vencido = await createProduct({ batches: [{ daysToExpiry: -5, quantity: 3 }] });
            const agotado = await createProduct({ batches: [{ daysToExpiry: 20, quantity: 0 }] });
            const inactivo = await createProduct({
                isActive: false,
                batches: [{ daysToExpiry: 20, quantity: 3 }],
            });
            await tieredPromo([lejano.id], 'Ya en promo');

            const suggestions = await promotionsService.listExpiringPromotionSuggestions({
                days: 90,
            });
            const ids = suggestions.map((entry) => entry.productId);
            expect(ids).not.toContain(fuera.id);
            expect(ids).not.toContain(vencido.id);
            expect(ids).not.toContain(agotado.id);
            expect(ids).not.toContain(inactivo.id);

            const mine = suggestions.filter((entry) =>
                [cercano.id, lejano.id].includes(entry.productId));
            expect(mine.map((entry) => [entry.productId, entry.daysToExpiry, entry.quantity,
                entry.suggestedRule.percent, entry.hasActivePromotion])).toEqual([
                [cercano.id, 10, 4, 30, false],
                [cercano.id, 45, 6, 20, false],
                [lejano.id, 80, 7, 10, true],
            ]);
            expect(mine[0]).toMatchObject({
                productName: cercano.name,
                categoryId: cercano.categoryId,
                salePrice: 35,
                suggestedRule: { type: 'percent', percent: 30, minQty: 1 },
            });
            expect(typeof mine[0].lotNumber).toBe('string');
            expect(Number.isNaN(Date.parse(mine[0].expiryDate))).toBe(false);
            // Orden global por cercanía.
            const days = suggestions.map((entry) => entry.daysToExpiry);
            expect(days).toEqual([...days].sort((a, b) => a - b));

            const corto = await promotionsService.listExpiringPromotionSuggestions({ days: 30 });
            expect(corto.filter((entry) => entry.productId === cercano.id)).toHaveLength(1);
        });

        it('una promo ya terminada no cuenta como activa', async () => {
            const product = await createProduct({ batches: [{ daysToExpiry: 15, quantity: 2 }] });
            const promo = await tieredPromo([product.id]);
            await db().collection('promotions').doc(promo.id).update({
                endsAt: Timestamp.fromMillis(Date.now() - DAY),
            });
            const suggestions = await promotionsService.listExpiringPromotionSuggestions({
                days: 90,
            });
            expect(suggestions.find((entry) => entry.productId === product.id)
                ?.hasActivePromotion).toBe(false);
        });

        it('days: entero 1..180, 90 por omisión', () => {
            expect(expiringSuggestionsQuerySchema.parse({})).toEqual({ days: 90 });
            expect(expiringSuggestionsQuerySchema.parse({ days: '30' })).toEqual({ days: 30 });
            expect(expiringSuggestionsQuerySchema.safeParse({ days: '0' }).success).toBe(false);
            expect(expiringSuggestionsQuerySchema.safeParse({ days: '181' }).success).toBe(false);
            expect(expiringSuggestionsQuerySchema.safeParse({ days: '7.5' }).success).toBe(false);
            expect(expiringSuggestionsQuerySchema.safeParse({ days: 'x' }).success).toBe(false);
        });

        it('la ruta se declara antes de :id (si no, "suggestions" se lee como id)', () => {
            const methods = Object.getOwnPropertyNames(PromotionsController.prototype);
            expect(methods.indexOf('expiringSuggestions')).toBeGreaterThan(-1);
            expect(methods.indexOf('expiringSuggestions')).toBeLessThan(methods.indexOf('get'));
            expect(methods.indexOf('performance')).toBeLessThan(methods.indexOf('get'));
        });
    });

    describe('POST /promotions/:id/replace', () => {
        it('crea la nueva, da de baja la vieja y liga las dos en la bitácora', async () => {
            const product = await createProduct();
            const vieja = await tieredPromo([product.id]);

            const { created, retired } = await promotionsService.replacePromotion(vieja.id, {
                name: 'Paracetamol 2x$55',
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 55 }] },
                productIds: [product.id],
            }, ADMIN);

            expect(created.isActive).toBe(true);
            expect(created.rule).toEqual({ type: 'tiered', tiers: [{ quantity: 2, price: 55 }] });
            expect(retired.id).toBe(vieja.id);
            expect(retired.isActive).toBe(false);
            expect(retired.deactivatedAt).toBeInstanceOf(Timestamp);
            expect((await promotionsService.getPromotion(vieja.id)).isActive).toBe(false);

            const oldLogs = await auditRepo.listAuditLogs({ entityId: vieja.id });
            expect(oldLogs.find((log) => log.action === 'promotion.deactivated')?.metadata)
                .toMatchObject({ reason: 'replaced', replacedBy: created.id });
            const newLogs = await auditRepo.listAuditLogs({ entityId: created.id });
            expect(newLogs.find((log) => log.action === 'promotion.created')?.metadata)
                .toMatchObject({ replaces: vieja.id });
        });

        it('si la nueva no valida, la vieja sigue activa y no se crea nada', async () => {
            const product = await createProduct();
            const vieja = await tieredPromo([product.id]);
            const before = await promotionsService.listPromotionsForSync({});

            // 2 por $80 sobre un producto de $35 no es descuento.
            await expectAppError(promotionsService.replacePromotion(vieja.id, {
                name: 'Mal capturada',
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 80 }] },
                productIds: [product.id],
            }, ADMIN), 'BAD_REQUEST');

            const intacta = await promotionsService.getPromotion(vieja.id);
            expect(intacta.isActive).toBe(true);
            expect(intacta.deactivatedAt).toBeNull();
            const after = await promotionsService.listPromotionsForSync({});
            expect(after.items).toHaveLength(before.items.length);
        });

        it('reemplazar una ya inactiva no la vuelve a dar de baja', async () => {
            const product = await createProduct();
            const vieja = await tieredPromo([product.id]);
            const baja = await promotionsService.deletePromotion(vieja.id, ADMIN);

            const { created, retired } = await promotionsService.replacePromotion(vieja.id, {
                name: 'Otra',
                rule: { type: 'nxm', buy: 3, pay: 2 },
                productIds: [product.id],
            }, ADMIN);
            expect(retired.isActive).toBe(false);
            expect(retired.deactivatedAt?.toMillis()).toBe(baja.deactivatedAt?.toMillis());
            const logs = await auditRepo.listAuditLogs({ entityId: vieja.id });
            expect(logs.filter((log) => log.action === 'promotion.deactivated')).toHaveLength(1);
            expect(logs.find((log) => log.action === 'promotion.updated')?.metadata)
                .toMatchObject({ reason: 'replaced', replacedBy: created.id });
        });

        it('si la baja de la vieja falla, da de baja la nueva: nunca quedan las dos activas', async () => {
            const product = await createProduct();
            const vieja = await tieredPromo([product.id]);
            const update = jest.spyOn(promotionsRepo, 'updatePromotion');
            update.mockRejectedValueOnce(new Error('Firestore no disponible'));

            try {
                await expect(promotionsService.replacePromotion(vieja.id, {
                    name: 'Paracetamol 2x$55',
                    rule: { type: 'tiered', tiers: [{ quantity: 2, price: 55 }] },
                    productIds: [product.id],
                }, ADMIN)).rejects.toThrow('Firestore no disponible');
            } finally {
                update.mockRestore();
            }

            expect((await promotionsService.getPromotion(vieja.id)).isActive).toBe(true);
            const { items } = await promotionsService.listPromotionsForSync({});
            const nuevas = items.filter((item) =>
                item.id !== vieja.id && item.productIds.includes(product.id));
            expect(nuevas).toHaveLength(1);
            expect(nuevas[0].isActive).toBe(false);
        });

        it('404 sin crear nada si la vieja no existe', async () => {
            const product = await createProduct();
            const before = await promotionsService.listPromotionsForSync({});
            await expectAppError(promotionsService.replacePromotion('no-existe', {
                name: 'Huérfana',
                rule: { type: 'nxm', buy: 2, pay: 1 },
                productIds: [product.id],
            }, ADMIN), 'NOT_FOUND');
            const after = await promotionsService.listPromotionsForSync({});
            expect(after.items).toHaveLength(before.items.length);
        });
    });

    describe('mantenimiento diario', () => {
        it('da de baja las vencidas con desempeño y lista las que terminan en 24 h', async () => {
            const product = await createProduct();
            const session = await openSession();
            const vencida = await tieredPromo([product.id], 'Vencida');
            const porTerminar = await tieredPromo([product.id], 'Por terminar');
            const lejana = await tieredPromo([product.id], 'Lejana');
            const sinFin = await tieredPromo([product.id], 'Sin fin');
            await sell({ productId: product.id, sessionId: session.id, quantity: 2,
                promotionId: vencida.id, discountAmount: 10 });
            const endsAtMs = Date.now() - 60 * 1000;
            await db().collection('promotions').doc(vencida.id).update({
                startsAt: Timestamp.fromMillis(Date.now() - 2 * DAY),
                endsAt: Timestamp.fromMillis(endsAtMs),
            });
            await db().collection('promotions').doc(porTerminar.id).update({
                endsAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 60 * 1000),
            });
            await db().collection('promotions').doc(lejana.id).update({
                endsAt: Timestamp.fromMillis(Date.now() + 3 * DAY),
            });

            const result = await runPromotionsMaintenance();

            // Otras pruebas del archivo dejan promos propias: se mira solo las de aquí.
            const closedIds = result.closed.map((entry) => entry.promotion.id);
            expect(closedIds).toContain(vencida.id);
            expect(closedIds).not.toContain(porTerminar.id);
            expect(closedIds).not.toContain(lejana.id);
            expect(closedIds).not.toContain(sinFin.id);
            const closedVencida = result.closed.find((entry) => entry.promotion.id === vencida.id);
            expect(closedVencida?.performance).toMatchObject({
                promotionId: vencida.id,
                unitsSold: 2,
                discountTotal: 10,
                daysActive: 2,
                endsAt: new Date(endsAtMs).toISOString(),
                effectiveEnd: new Date(endsAtMs).toISOString(),
            });
            const soonIds = result.endingSoon.map((promotion) => promotion.id);
            expect(soonIds).toContain(porTerminar.id);
            expect(soonIds).not.toContain(lejana.id);
            expect(soonIds).not.toContain(sinFin.id);

            const cerrada = await promotionsService.getPromotion(vencida.id);
            expect(cerrada.isActive).toBe(false);
            expect(cerrada.updatedBy).toBe('system');
            const logs = await auditRepo.listAuditLogs({ entityId: vencida.id });
            const baja = logs.find((log) => log.action === 'promotion.deactivated');
            expect(baja?.userId).toBe('system');
            expect(baja?.metadata).toMatchObject({ reason: 'expired' });

            for (const id of [porTerminar.id, lejana.id, sinFin.id]) {
                expect((await promotionsService.getPromotion(id)).isActive).toBe(true);
            }

            // Segunda corrida: ya no hay nada que cerrar.
            const again = await runPromotionsMaintenance();
            expect(again.closed).toHaveLength(0);
            expect(await auditRepo.listAuditLogs({ entityId: vencida.id }))
                .toHaveLength(logs.length);
        });

        it('manda correo solo cuando hay algo que avisar', async () => {
            const product = await createProduct();
            const promo = await tieredPromo([product.id], 'Termina hoy');
            // Sin nada: la corrida no manda correo. (La suite limpia la base por
            // archivo, así que se mide contra un "ahora" en que nada vence.)
            await db().collection('promotions').doc(promo.id).update({
                endsAt: Timestamp.fromMillis(Date.now() + 10 * DAY),
            });
            const quiet = await sendPromotionsMaintenanceReport({ nowMs: Date.now() - 400 * DAY });
            expect(quiet.sent).toBe(false);
            expect(sendMock).not.toHaveBeenCalled();

            await db().collection('promotions').doc(promo.id).update({
                endsAt: Timestamp.fromMillis(Date.now() + 2 * 60 * 60 * 1000),
            });
            const loud = await sendPromotionsMaintenanceReport();
            expect(loud.sent).toBe(true);
            expect(sendMock).toHaveBeenCalledTimes(1);
            expect(sendMock.mock.calls[0][0].subject).toMatch(/terminan en 24 h/);
            expect(sendMock.mock.calls[0][0].attachment).toBeUndefined();
        });
    });

    describe('baja por cambio de precio', () => {
        it('avisa por correo qué promo se dio de baja y por qué', async () => {
            const product = await createProduct();
            const promo = await tieredPromo([product.id]);
            await productsService.updateProduct(product.id, { salePrice: 61 }, ADMIN);

            expect((await promotionsService.getPromotion(promo.id)).isActive).toBe(false);
            expect(sendMock).toHaveBeenCalledTimes(1);
            const email = sendMock.mock.calls[0][0];
            expect(email.subject).toContain(promo.name);
            expect(email.subject).toContain('cambio de precio');
        });

        it('si el correo falla, la baja y el precio se quedan igual', async () => {
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            sendMock.mockRejectedValueOnce(new Error('Resend caído'));
            const product = await createProduct();
            const promo = await tieredPromo([product.id]);

            const updated = await productsService.updateProduct(
                product.id,
                { salePrice: 61 },
                ADMIN,
            );
            expect(updated.salePrice).toBe(61);
            expect((await promotionsService.getPromotion(promo.id)).isActive).toBe(false);
            const logs = await auditRepo.listAuditLogs({ entityId: promo.id });
            expect(logs.map((log) => log.action)).toContain('promotion.deactivated');
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });

        it('sin bajas no manda correo', async () => {
            const product = await createProduct();
            await tieredPromo([product.id]);
            await productsService.updateProduct(product.id, { salePrice: 36 }, ADMIN);
            expect(sendMock).not.toHaveBeenCalled();
        });
    });

    describe('reporte de ventas', () => {
        it('lista las ventas con promoción por revisar del periodo', async () => {
            const product = await createProduct();
            const promo = await tieredPromo([product.id]);
            const session = await openSession();
            await db().collection('promotions').doc(promo.id).update({
                isActive: false,
                deactivatedAt: Timestamp.fromMillis(Date.now() - 4 * DAY),
            });
            const marcada = await sell({ productId: product.id, sessionId: session.id,
                quantity: 2, promotionId: promo.id, discountAmount: 10, offline: true });
            expect(marcada.promotionReview).toBe(true);
            const anulada = await sell({ productId: product.id, sessionId: session.id,
                quantity: 2, promotionId: promo.id, discountAmount: 10, offline: true });
            await db().collection('sales').doc(anulada.id).update({
                voidedAt: Timestamp.now(),
                voidedBy: 'admin-user',
            });

            const hoy = new Intl.DateTimeFormat('en-CA', {
                timeZone: REPORTS_TIME_ZONE,
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
            }).format(new Date());
            const report = await buildDailyReport(hoy);
            expect(report.promotionReview.folios).toContain(marcada.folio);
            expect(report.promotionReview.folios).not.toContain(anulada.folio);
            expect(report.promotionReview.count).toBe(report.promotionReview.folios.length);
        });
    });
});
