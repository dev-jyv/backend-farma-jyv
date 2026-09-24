import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import * as promotionsService from '../src/services/promotions.service';
import * as productsService from '../src/services/products.service';
import * as analyticsService from '../src/services/analytics.service';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as receiptsService from '../src/services/receipts.service';
import { createPromotionSchema, updatePromotionSchema } from '../src/schemas';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };

const createProduct = async (salePrice = 35) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Paracetamol'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'caja',
        salePrice,
        minStock: 1,
        totalStock: 0,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2028-01-01'),
        quantity: 50,
        costPrice: 10,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 50 });
    return product;
};

const openSession = (userId = 'test-cashier') => cashSessionsRepo.createCashSession({
    openedBy: userId,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const paracetamolPromo = (productId: string) => promotionsService.createPromotion({
    name: 'Paracetamol 2x$60',
    rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
    productIds: [productId],
}, ADMIN);

const expectAppError = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ code });
};

describe('promociones', () => {
    describe('esquema', () => {
        it('rechaza escalones con precio por pieza que sube', () => {
            const result = createPromotionSchema.safeParse({
                name: 'Mal',
                rule: {
                    type: 'tiered',
                    tiers: [{ quantity: 2, price: 60 }, { quantity: 3, price: 100 }],
                },
                productIds: ['p1'],
            });
            expect(result.success).toBe(false);
        });

        it('rechaza un NxM que paga lo mismo que lleva', () => {
            const result = createPromotionSchema.safeParse({
                name: 'Mal',
                rule: { type: 'nxm', buy: 2, pay: 2 },
                productIds: ['p1'],
            });
            expect(result.success).toBe(false);
        });

        it('el update no acepta cambiar la regla ni los productos', () => {
            expect(updatePromotionSchema.safeParse({
                rule: { type: 'nxm', buy: 2, pay: 1 },
            }).success).toBe(false);
            expect(updatePromotionSchema.safeParse({ productIds: ['x'] }).success).toBe(false);
            expect(updatePromotionSchema.safeParse({ name: 'Nuevo' }).success).toBe(true);
        });
    });

    describe('CRUD', () => {
        it('crea, audita, y la baja sella deactivatedAt y aparece en el sync', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            expect(promo.isActive).toBe(true);
            expect(promo.deactivatedAt).toBeNull();

            const since = new Date(Date.now() - 1000).toISOString();
            const removed = await promotionsService.deletePromotion(promo.id, ADMIN);
            expect(removed.isActive).toBe(false);
            expect(removed.deactivatedAt).toBeInstanceOf(Timestamp);

            const synced = await promotionsService.listPromotionsForSync({ updatedSince: since });
            expect(synced.items.map((item) => item.id)).toContain(promo.id);

            const logs = await auditRepo.listAuditLogs({ entityId: promo.id });
            expect(logs.map((log) => log.action).sort()).toEqual(
                ['promotion.created', 'promotion.deactivated'],
            );
        });

        it('reactivar limpia deactivatedAt, revalida y se audita aparte', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            await promotionsService.deletePromotion(promo.id, ADMIN);
            const back = await promotionsService.updatePromotion(
                promo.id,
                { isActive: true },
                ADMIN,
            );
            expect(back.isActive).toBe(true);
            expect(back.deactivatedAt).toBeNull();
            expect(back.name).toBe('Paracetamol 2x$60');

            const logs = await auditRepo.listAuditLogs({ entityId: promo.id });
            expect(logs.map((log) => log.action)).toContain('promotion.reactivated');

            await promotionsService.deletePromotion(promo.id, ADMIN);
            await productsRepo.updateProduct(product.id, { salePrice: 25 });
            await expectAppError(
                promotionsService.updatePromotion(promo.id, { isActive: true }, ADMIN),
                'BAD_REQUEST',
            );
        });

        it('F1: subir el precio da de baja la promo que deja de tener sentido', async () => {
            const product = await createProduct(35);
            const promo = await paracetamolPromo(product.id);
            const sano = await createProduct(35);
            const promoSana = await paracetamolPromo(sano.id);

            // $36 sigue siendo buena promo (72 vs 60); $61 la vuelve absurda.
            await productsService.updateProduct(sano.id, { salePrice: 36 }, ADMIN);
            await productsService.updateProduct(product.id, { salePrice: 61 }, ADMIN);

            expect((await promotionsService.getPromotion(promoSana.id)).isActive).toBe(true);
            const retirada = await promotionsService.getPromotion(promo.id);
            expect(retirada.isActive).toBe(false);
            expect(retirada.deactivatedAt).not.toBeNull();
            const logs = await auditRepo.listAuditLogs({ entityId: promo.id });
            expect(logs.find((log) => log.action === 'promotion.deactivated')?.metadata)
                .toMatchObject({ reason: 'price_changed' });
        });

        it('F1: la actualización masiva de precios también revisa las promos', async () => {
            const product = await createProduct(35);
            const promo = await paracetamolPromo(product.id);
            await productsService.updateProductPrices(
                [{ productId: product.id, salePrice: 61 }],
                ADMIN,
            );
            expect((await promotionsService.getPromotion(promo.id)).isActive).toBe(false);
        });

        it('rechaza un paquete que no es más barato que las piezas sueltas', async () => {
            const product = await createProduct(25);
            await expectAppError(paracetamolPromo(product.id), 'BAD_REQUEST');
        });

        it('rechaza una regla donde llevar más cuesta menos (25% desde 5)', async () => {
            const product = await createProduct(100);
            await expectAppError(promotionsService.createPromotion({
                name: 'Mal',
                rule: { type: 'percent', percent: 25, minQty: 5 },
                productIds: [product.id],
            }, ADMIN), 'BAD_REQUEST');
        });

        it('rechaza un producto inexistente', async () => {
            await expectAppError(paracetamolPromo('no-existe'), 'BAD_REQUEST');
        });
    });

    describe('venta', () => {
        it('2 paracetamol a $35 con la promo cobran $60', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession();

            const sale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 35,
                    discountAmount: 10,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                roleSlug: 'cashier',
            });

            expect(sale.total).toBe(60);
            expect(sale.promotionDiscountTotal).toBe(10);
            expect(sale.promotionIds).toEqual([promo.id]);
            expect(productItem(sale, 0).promotion).toMatchObject({
                promotionId: promo.id,
                discountAmount: 10,
                rule: promo.rule,
            });
        });

        it('un 2x1 (50%) no choca con el tope de descuento del cajero', async () => {
            const product = await createProduct(20);
            const promo = await promotionsService.createPromotion({
                name: '2x1',
                rule: { type: 'nxm', buy: 2, pay: 1 },
                productIds: [product.id],
            }, ADMIN);
            const session = await openSession();

            const sale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 20,
                    discountAmount: 20,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 20,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                roleSlug: 'cashier',
            });
            expect(sale.total).toBe(20);
        });

        it('el descuento manual encima de la promo sí respeta el tope', async () => {
            const product = await createProduct(20);
            const promo = await promotionsService.createPromotion({
                name: '2x1',
                rule: { type: 'nxm', buy: 2, pay: 1 },
                productIds: [product.id],
            }, ADMIN);
            const session = await openSession();

            // Promo 20 + manual 5: el tope es 20 % de lo que queda tras la promo (4).
            await expectAppError(salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 20,
                    discountAmount: 25,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 20,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                roleSlug: 'cashier',
            }), 'FORBIDDEN');
        });

        it('sin promotionId el mismo descuento sigue topado', async () => {
            const product = await createProduct(20);
            const session = await openSession();
            await expectAppError(salesService.createSale({
                items: [{ productId: product.id, quantity: 2, unitPrice: 20, discountAmount: 20 }],
                paymentMethod: 'cash',
                amountReceived: 20,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                roleSlug: 'cashier',
            }), 'FORBIDDEN');
        });

        it('rechaza una promo de otro producto', async () => {
            const product = await createProduct();
            const other = await createProduct();
            const promo = await paracetamolPromo(other.id);
            const session = await openSession();
            await expectAppError(salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 35,
                    discountAmount: 10,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }), 'BAD_REQUEST');
        });

        const saleWithPromo = (productId: string, promotionId: string, sessionId: string,
            offline?: boolean) => salesService.createSale({
            items: [{ productId, quantity: 2, unitPrice: 35, discountAmount: 10, promotionId }],
            paymentMethod: 'cash',
            amountReceived: 60,
            cashSessionId: sessionId,
            cashierId: 'test-cashier',
            offline,
        });

        it('en línea, una promo dada de baja se rechaza de inmediato', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            await promotionsService.deletePromotion(promo.id, ADMIN);
            const session = await openSession();
            await expectAppError(saleWithPromo(product.id, promo.id, session.id), 'BAD_REQUEST');
        });

        it('offline (/sales/bulk) se acepta dentro del margen sin marcarse', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession();

            await promotionsService.deletePromotion(promo.id, ADMIN);
            const sale = await saleWithPromo(product.id, promo.id, session.id, true);
            expect(sale.promotionDiscountTotal).toBe(10);
            expect(sale.promotionReview).toBeUndefined();
        });

        const daysAgo = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;

        it('F3: cobrada en vigencia y empujada 4 días después: soldAt la valida', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            await db().collection('promotions').doc(promo.id).update({
                startsAt: Timestamp.fromMillis(daysAgo(10)),
                isActive: false,
                deactivatedAt: Timestamp.fromMillis(daysAgo(4)),
            });
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, unitPrice: 35,
                    discountAmount: 10, promotionId: promo.id }],
                paymentMethod: 'cash',
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                offline: true,
                soldAt: new Date(daysAgo(5)).toISOString(),
            });
            expect(sale.total).toBe(60);
            expect(sale.promotionReview).toBeUndefined();
        });

        it('F3 sin soldAt y fuera del margen: se acepta marcada y auditada', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            await db().collection('promotions').doc(promo.id).update({
                isActive: false,
                deactivatedAt: Timestamp.fromMillis(daysAgo(4)),
            });
            const session = await openSession();
            const sale = await saleWithPromo(product.id, promo.id, session.id, true);

            expect(sale.total).toBe(60);
            expect(sale.promotionReview).toBe(true);
            expect(productItem(sale, 0).promotion).toMatchObject({ outOfWindow: true });
            const logs = await auditRepo.listAuditLogs({ entityId: sale.id });
            expect(logs.map((log) => log.action)).toContain('sale.promotion_out_of_window');
        });

        it('el reporte de ventas suma el descuento por promociones', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession();
            const window = () => ({
                from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            });
            // Diferencia antes/después: otras pruebas del archivo venden en la
            // misma ventana.
            const before = await analyticsService.getSalesSummary(window());
            await saleWithPromo(product.id, promo.id, session.id);
            const after = await analyticsService.getSalesSummary(window());
            expect(after.promotionDiscountTotal - before.promotionDiscountTotal).toBeCloseTo(10, 2);
        });

        it('GET /sales?promotionReview=true lista solo las marcadas', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession();
            const normal = await saleWithPromo(product.id, promo.id, session.id, true);
            await db().collection('promotions').doc(promo.id).update({
                isActive: false,
                deactivatedAt: Timestamp.fromMillis(daysAgo(4)),
            });
            const marcada = await saleWithPromo(product.id, promo.id, session.id, true);

            const { items } = await salesService.listSales({
                promotionReview: true,
                requesterId: 'admin-user',
                requesterRoleSlug: 'admin',
            });
            const ids = items.map((sale) => sale.id);
            expect(ids).toContain(marcada.id);
            expect(ids).not.toContain(normal.id);
        });

        it('F2: reloj adelantado (promo que aún no inicia): se acepta marcada', async () => {
            const product = await createProduct();
            const promo = await promotionsService.createPromotion({
                name: 'Mañana',
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
                productIds: [product.id],
                startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }, ADMIN);
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, unitPrice: 35,
                    discountAmount: 10, promotionId: promo.id }],
                paymentMethod: 'cash',
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                offline: true,
                // Reloj de la caja 2 h adelantado: no se le cree.
                soldAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            });
            expect(sale.total).toBe(60);
            expect(sale.promotionReview).toBe(true);
        });

        it('en línea, una promo que aún no inicia sí se rechaza', async () => {
            const product = await createProduct();
            const promo = await promotionsService.createPromotion({
                name: 'Mañana',
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
                productIds: [product.id],
                startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }, ADMIN);
            const session = await openSession();
            await expectAppError(saleWithPromo(product.id, promo.id, session.id), 'BAD_REQUEST');
        });

        it('el reintento con la misma llave devuelve la venta aunque la promo ya cerró',
            async () => {
                const product = await createProduct();
                const promo = await paracetamolPromo(product.id);
                const session = await openSession();
                const input = {
                    idempotencyKey: unique('key'),
                    items: [{
                        productId: product.id,
                        quantity: 2,
                        unitPrice: 35,
                        discountAmount: 10,
                        promotionId: promo.id,
                    }],
                    paymentMethod: 'cash' as const,
                    amountReceived: 60,
                    cashSessionId: session.id,
                    cashierId: 'test-cashier',
                };
                const first = await salesService.createSale(input);
                await promotionsService.deletePromotion(promo.id, ADMIN);
                const replay = await salesService.createSale(input);
                expect(replay.id).toBe(first.id);
            });

        it('el monto de la promo lo calcula el servidor, no el cliente', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession();
            // El cliente descuenta 15 alegando la promo: 10 son promo, 5 manual.
            const sale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 35,
                    discountAmount: 15,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 55,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                roleSlug: 'cashier',
            });
            expect(sale.promotionDiscountTotal).toBe(10);
            expect(sale.discountTotal).toBe(15);
        });

        it('el recibo imprime el nombre de la promo', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 35,
                    discountAmount: 10,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            });
            const { receipt, html } = await receiptsService.getSaleReceipt(sale.id);
            expect(receipt.lines[0]).toMatchObject({
                promotionName: 'Paracetamol 2x$60',
                promotionDiscount: 10,
            });
            expect(html).toContain('Promo Paracetamol 2x$60');
            expect(html).not.toContain('Desc.');
        });
    });

    describe('devolución', () => {
        it('2 por $60 y se devuelve 1: reembolsa $25; la segunda, el remanente $35', async () => {
            const product = await createProduct();
            const promo = await paracetamolPromo(product.id);
            const session = await openSession('admin-user');
            const sale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 35,
                    discountAmount: 10,
                    promotionId: promo.id,
                }],
                paymentMethod: 'cash',
                amountReceived: 60,
                cashSessionId: session.id,
                cashierId: 'admin-user',
                roleSlug: 'admin',
            });

            const first = await returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity: 1 }],
                reason: 'No la quiso',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            });
            expect(first.refundTotal).toBe(25);

            const second = await returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity: 1 }],
                reason: 'Tampoco la otra',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            });
            expect(second.refundTotal).toBe(35);
        });
    });
});
