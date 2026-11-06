import { Timestamp } from 'firebase-admin/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import * as couponsRepo from '../src/repositories/coupons.repository';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import * as couponsService from '../src/services/coupons.service';
import * as promotionsService from '../src/services/promotions.service';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as receiptsService from '../src/services/receipts.service';
import * as analyticsService from '../src/services/analytics.service';
import { REPORT_REGISTRY } from '../src/services/report-export/registry';
import { createCouponSchema, createSaleSchema } from '../src/schemas';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';
import { toCents } from '../src/utils/taxes';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

/** SPEC 47 — cupones de descuento por producto y por venta. */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
let codeSeq = 0;
const newCode = () => `CUP-${Date.now().toString(36).toUpperCase().slice(-6)}${codeSeq++}`;
const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };
const CASHIER = 'test-cashier';

const createProduct = async (salePrice = 100, overrides: Record<string, unknown> = {}) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice,
        minStock: 1,
        totalStock: 0,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        isActive: true,
        suppliers: [],
        ...overrides,
    });
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2028-01-01'),
        quantity: 100,
        costPrice: 10,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 100 });
    return product;
};

const openSession = (userId = CASHIER) => cashSessionsRepo.createCashSession({
    openedBy: userId,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const productCoupon = (productIds: string[], percent = 10, extra: Record<string, unknown> = {}) =>
    couponsService.createCoupon({
        code: newCode(),
        name: 'Cupón producto',
        scope: 'product',
        productIds,
        discount: { type: 'percent', percent },
        ...extra,
    }, ADMIN);

const saleCoupon = (amount = 50, extra: Record<string, unknown> = {}) =>
    couponsService.createCoupon({
        code: newCode(),
        name: 'Cupón venta',
        scope: 'sale',
        discount: { type: 'amount', amount },
        ...extra,
    }, ADMIN);

const catchError = (promise: Promise<unknown>) =>
    promise.then(() => null, (error: unknown) => error as AppError);

const expectAppError = async (promise: Promise<unknown>, code: string, message?: string) => {
    const error = await catchError(promise);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code });
    if (message) {
        expect(error!.message).toContain(message);
    }
};

const daysAgo = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;

/** Venta de una pieza de $100 con cupón de venta de $50 (online o bulk). */
const sellWithSaleCoupon = (
    productId: string,
    code: string,
    sessionId: string,
    extra: Partial<Parameters<typeof salesService.createSale>[0]> = {},
) => salesService.createSale({
    items: [{ productId, quantity: 1, unitPrice: 100 }],
    saleDiscountAmount: 50,
    couponCode: code,
    paymentMethod: 'cash',
    amountReceived: 50,
    cashSessionId: sessionId,
    cashierId: CASHIER,
    roleSlug: 'cashier',
    ...extra,
});

describe('cupones (SPEC 47)', () => {
    describe('esquema', () => {
        const base = {
            code: ' ver-10 ',
            name: 'Verano',
            scope: 'sale',
            discount: { type: 'percent', percent: 10 },
        };

        it('normaliza el código a mayúsculas y lo valida', () => {
            const parsed = createCouponSchema.safeParse(base);
            expect(parsed.success && parsed.data.code).toBe('VER-10');
            expect(createCouponSchema.safeParse({ ...base, code: 'ab' }).success).toBe(false);
            expect(createCouponSchema.safeParse({ ...base, code: 'NO VALE' }).success).toBe(false);
            expect(createCouponSchema.safeParse({ ...base, code: 'A'.repeat(21) }).success)
                .toBe(false);
        });

        it('porcentaje 1–90 y monto positivo', () => {
            const discount = (value: unknown) =>
                createCouponSchema.safeParse({ ...base, discount: value }).success;
            expect(discount({ type: 'percent', percent: 90 })).toBe(true);
            expect(discount({ type: 'percent', percent: 91 })).toBe(false);
            expect(discount({ type: 'percent', percent: 0.5 })).toBe(false);
            expect(discount({ type: 'amount', amount: 0 })).toBe(false);
            expect(discount({ type: 'amount', amount: 25.5 })).toBe(true);
        });

        it('productos solo en alcance producto; mínimo solo en alcance venta', () => {
            expect(createCouponSchema.safeParse({ ...base, scope: 'product' }).success).toBe(false);
            expect(createCouponSchema.safeParse({ ...base, productIds: ['p1'] }).success)
                .toBe(false);
            expect(createCouponSchema.safeParse({
                ...base, scope: 'product', productIds: ['p1'], minPurchase: 100,
            }).success).toBe(false);
            expect(createCouponSchema.safeParse({
                ...base,
                scope: 'product',
                productIds: Array.from({ length: 51 }, (_, i) => `p${i}`),
            }).success).toBe(false);
            expect(createCouponSchema.safeParse({ ...base, minPurchase: 300 }).success).toBe(true);
        });

        it('la venta acepta couponCode y lo normaliza', () => {
            const parsed = createSaleSchema.safeParse({
                items: [{ productId: 'p1', quantity: 1 }],
                paymentMethod: 'card',
                cashSessionId: 's1',
                couponCode: 'ver-10',
            });
            expect(parsed.success && parsed.data.couponCode).toBe('VER-10');
        });
    });

    describe('alta, baja y sync', () => {
        it('crea con el código como id, en ISO y auditado; el código no se repite', async () => {
            const product = await createProduct();
            const code = newCode();
            const created = await couponsService.createCoupon({
                code,
                name: 'Diez',
                scope: 'product',
                productIds: [product.id],
                discount: { type: 'percent', percent: 10 },
                maxUses: 5,
            }, ADMIN);

            expect(created).toMatchObject({
                id: code,
                code,
                scope: 'product',
                productIds: [product.id],
                minPurchase: null,
                endsAt: null,
                maxUses: 5,
                usedCount: 0,
                isActive: true,
                deactivatedAt: null,
                createdBy: 'admin-user',
            });
            expect(typeof created.startsAt).toBe('string');
            expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
            expect((await db().collection('coupons').doc(code).get()).exists).toBe(true);

            await expectAppError(couponsService.createCoupon({
                code,
                name: 'Otro',
                scope: 'sale',
                discount: { type: 'amount', amount: 10 },
            }, ADMIN), 'CONFLICT', 'Ya existe un cupón con ese código');

            const logs = await auditRepo.listAuditLogs({ entityId: code });
            expect(logs.map((log) => log.action)).toEqual(['coupon.created']);
        });

        it('rechaza productos inexistentes', async () => {
            await expectAppError(productCoupon(['no-existe']), 'BAD_REQUEST', 'no existe');
        });

        it('baja: sella deactivatedAt, se audita una vez y aparece en el sync', async () => {
            const coupon = await saleCoupon();
            const since = new Date(Date.now() - 1000).toISOString();
            const removed = await couponsService.deactivateCoupon(coupon.code, ADMIN);
            expect(removed.isActive).toBe(false);
            expect(typeof removed.deactivatedAt).toBe('string');
            await couponsService.deactivateCoupon(coupon.code, ADMIN);

            const logs = await auditRepo.listAuditLogs({ entityId: coupon.code });
            expect(logs.map((log) => log.action).sort())
                .toEqual(['coupon.created', 'coupon.deactivated']);

            const synced = await couponsService.listCouponsForSync({ updatedSince: since });
            expect(synced.items.map((item) => item.code)).toContain(coupon.code);
            expect(Date.parse(synced.serverTime)).not.toBeNaN();

            const inactive = await couponsService.listCoupons({ isActive: false });
            expect(inactive.items.map((item) => item.code)).toContain(coupon.code);
            const active = await couponsService.listCoupons({ isActive: true });
            expect(active.items.map((item) => item.code)).not.toContain(coupon.code);
            expect(active.meta).toMatchObject({ page: 1 });

            expect((await couponsService.getCoupon(coupon.code)).isActive).toBe(false);
            await expectAppError(couponsService.getCoupon('NO-EXISTE'), 'NOT_FOUND');
        });
    });

    describe('venta en línea', () => {
        it('cupón de producto 10 %: solo partidas elegibles y sin promoción', async () => {
            const eligible = await createProduct(100);
            const promoted = await createProduct(35);
            const other = await createProduct(50);
            const promo = await promotionsService.createPromotion({
                name: '2x$60',
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
                productIds: [promoted.id],
            }, ADMIN);
            const coupon = await productCoupon([eligible.id, promoted.id], 10);
            const session = await openSession();

            const sale = await salesService.createSale({
                items: [
                    { productId: eligible.id, quantity: 2, unitPrice: 100, discountAmount: 20 },
                    {
                        productId: promoted.id, quantity: 2, unitPrice: 35,
                        discountAmount: 10, promotionId: promo.id,
                    },
                    { productId: other.id, quantity: 1, unitPrice: 50 },
                ],
                couponCode: coupon.code.toLowerCase(),
                paymentMethod: 'cash',
                amountReceived: 290,
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
            });

            expect(sale.total).toBe(290);
            expect(productItem(sale, 0).coupon)
                .toEqual({ couponId: coupon.id, discountAmount: 20 });
            expect(productItem(sale, 1).coupon).toBeUndefined();
            expect(productItem(sale, 2).coupon).toBeUndefined();
            expect(sale.couponDiscountTotal).toBe(20);
            expect(sale.coupon).toEqual({
                couponId: coupon.id,
                code: coupon.code,
                name: coupon.name,
                scope: 'product',
                discount: { type: 'percent', percent: 10 },
                discountAmount: 20,
            });
            expect(sale.couponReview).toBeUndefined();
            expect((await couponsRepo.getCouponByCode(coupon.code))?.usedCount).toBe(1);

            // `mapSale` es lista blanca: el cupón tiene que sobrevivir la lectura.
            const read = await salesRepo.getSaleById(sale.id);
            expect(read?.coupon).toEqual(sale.coupon);
            expect(read?.couponDiscountTotal).toBe(20);
            expect(productItem(read!, 0).coupon?.discountAmount).toBe(20);
        });

        it('el cupón no cuenta para el tope del 20 % del cajero; lo extra sí', async () => {
            const product = await createProduct(100);
            const coupon = await productCoupon([product.id], 50);
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 100, discountAmount: 50 }],
                couponCode: coupon.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
            });
            expect(sale.total).toBe(50);
            expect(sale.couponDiscountTotal).toBe(50);

            // 50 del cupón + 11 manuales: 11 > 20 % de lo que queda (50) → 403.
            await expectAppError(salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 100, discountAmount: 61 }],
                couponCode: coupon.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
            }), 'FORBIDDEN');
        });

        it('el monto lo calcula el servidor: con tope en lo que mandó la caja', async () => {
            const product = await createProduct(100);
            const coupon = await couponsService.createCoupon({
                code: newCode(),
                name: '$30 por pieza',
                scope: 'product',
                productIds: [product.id],
                discount: { type: 'amount', amount: 30 },
            }, ADMIN);
            const session = await openSession();
            // La caja descontó de menos: se toma lo que descontó.
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, unitPrice: 100, discountAmount: 40 }],
                couponCode: coupon.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'admin',
            });
            expect(sale.couponDiscountTotal).toBe(40);
            // La caja descontó de más: el exceso es manual (admin, sin tope).
            const over = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, unitPrice: 100, discountAmount: 70 }],
                couponCode: coupon.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'admin',
            });
            expect(over.couponDiscountTotal).toBe(60);
            expect(over.total).toBe(130);
        });

        it('cupón de venta de $50: se prorratea y los impuestos cuadran al centavo', async () => {
            const withIva = await createProduct(116.37, {
                hasIva: true, hasIvaZero: false, hasIeps: true, iepsRate: 0.08,
            });
            const zero = await createProduct(33.33);
            const coupon = await saleCoupon(50, { minPurchase: 100 });
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [
                    { productId: withIva.id, quantity: 3, unitPrice: 116.37 },
                    { productId: zero.id, quantity: 1, unitPrice: 33.33 },
                ],
                saleDiscountAmount: 50,
                couponCode: coupon.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
            });

            expect(toCents(sale.total)).toBe(toCents(349.11 + 33.33) - 5000);
            expect(sale.couponDiscountTotal).toBe(50);
            expect(sale.coupon?.scope).toBe('sale');
            const shares = sale.items
                .reduce((sum, item) => sum + toCents(item.saleDiscountShare!), 0);
            expect(shares).toBe(5000);
            for (const item of sale.items) {
                const taxes = item.taxes!;
                expect(toCents(taxes.base) + toCents(taxes.ivaAmount) + toCents(taxes.iepsAmount))
                    .toBe(toCents(item.netAmount!));
            }
            expect(toCents(sale.taxSummary!.total)).toBe(toCents(sale.total));
        });

        it('rechaza con 400: mínimo no alcanzado, solo líneas con promo, inexistente', async () => {
            const product = await createProduct(100);
            const session = await openSession();
            const minimum = await saleCoupon(50, { minPurchase: 300 });
            await expectAppError(
                sellWithSaleCoupon(product.id, minimum.code, session.id),
                'BAD_REQUEST',
                'compra mínima',
            );

            const promoted = await createProduct(35);
            const promo = await promotionsService.createPromotion({
                name: '2x$60',
                rule: { type: 'tiered', tiers: [{ quantity: 2, price: 60 }] },
                productIds: [promoted.id],
            }, ADMIN);
            const onlyPromo = await productCoupon([promoted.id], 10);
            await expectAppError(salesService.createSale({
                items: [{
                    productId: promoted.id, quantity: 2, unitPrice: 35,
                    discountAmount: 10, promotionId: promo.id,
                }],
                couponCode: onlyPromo.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
            }), 'BAD_REQUEST', 'ya tienen promoción');

            await expectAppError(
                sellWithSaleCoupon(product.id, 'NO-EXISTE-1', session.id),
                'BAD_REQUEST',
                'no existe',
            );
            const inactive = await saleCoupon();
            await couponsService.deactivateCoupon(inactive.code, ADMIN);
            await expectAppError(
                sellWithSaleCoupon(product.id, inactive.code, session.id),
                'BAD_REQUEST',
                'no está vigente',
            );
            // Nada de lo anterior consumió usos.
            expect((await couponsRepo.getCouponByCode(minimum.code))?.usedCount).toBe(0);
        });

        it('agotado en línea da 400 y no rebasa maxUses', async () => {
            const product = await createProduct(100);
            const coupon = await saleCoupon(50, { maxUses: 1 });
            const session = await openSession();
            await sellWithSaleCoupon(product.id, coupon.code, session.id);
            await expectAppError(
                sellWithSaleCoupon(product.id, coupon.code, session.id),
                'BAD_REQUEST',
                'límite de usos',
            );
            expect((await couponsRepo.getCouponByCode(coupon.code))?.usedCount).toBe(1);
        });

        it('concurrencia sobre el último uso: una pasa, la otra 400', async () => {
            const product = await createProduct(100);
            const coupon = await saleCoupon(50, { maxUses: 1 });
            const session = await openSession();
            const results = await Promise.allSettled([
                sellWithSaleCoupon(product.id, coupon.code, session.id),
                sellWithSaleCoupon(product.id, coupon.code, session.id),
            ]);
            const fulfilled = results.filter((result) => result.status === 'fulfilled');
            const rejected = results.filter(
                (result): result is PromiseRejectedResult => result.status === 'rejected',
            );
            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            expect(rejected[0].reason).toMatchObject({ code: 'BAD_REQUEST' });
            expect((await couponsRepo.getCouponByCode(coupon.code))?.usedCount).toBe(1);
        });

        it('idempotencia: misma llave devuelve la venta aunque el cupón ya se agotó; '
            + 'otro cupón con la misma llave es CONFLICT', async () => {
            const product = await createProduct(100);
            const coupon = await saleCoupon(50, { maxUses: 1 });
            const other = await saleCoupon(50);
            const session = await openSession();
            const key = unique('idem-cupon');
            const first = await sellWithSaleCoupon(product.id, coupon.code, session.id, {
                idempotencyKey: key,
            });
            const replay = await sellWithSaleCoupon(product.id, coupon.code, session.id, {
                idempotencyKey: key,
            });
            expect(replay.id).toBe(first.id);
            expect((await couponsRepo.getCouponByCode(coupon.code))?.usedCount).toBe(1);

            await expectAppError(sellWithSaleCoupon(product.id, other.code, session.id, {
                idempotencyKey: key,
            }), 'CONFLICT');
        });
    });

    describe('venta offline (/sales/bulk)', () => {
        it('agotado: se acepta con couponReview over_limit y bitácora', async () => {
            const product = await createProduct(100);
            const coupon = await saleCoupon(50, { maxUses: 1 });
            const session = await openSession();
            await sellWithSaleCoupon(product.id, coupon.code, session.id, { offline: true });
            const second = await sellWithSaleCoupon(product.id, coupon.code, session.id, {
                offline: true,
            });
            expect(second.total).toBe(50);
            expect(second.couponDiscountTotal).toBe(50);
            expect(second.couponReview).toEqual({ reason: 'over_limit', code: coupon.code });
            expect((await couponsRepo.getCouponByCode(coupon.code))?.usedCount).toBe(2);
            const logs = await auditRepo.listAuditLogs({ entityId: second.id });
            expect(logs.map((log) => log.action)).toContain('sale.coupon_review');
            expect((await salesRepo.getSaleById(second.id))?.couponReview)
                .toEqual(second.couponReview);
        });

        it('fuera de vigencia: soldAt confiable la valida; sin soldAt y fuera de margen, '
            + 'se marca out_of_window', async () => {
            const product = await createProduct(100);
            const coupon = await saleCoupon(50);
            await db().collection('coupons').doc(coupon.code).update({
                startsAt: Timestamp.fromMillis(daysAgo(10)),
                isActive: false,
                deactivatedAt: Timestamp.fromMillis(daysAgo(4)),
            });
            const session = await openSession();
            // El turno ya estaba abierto cuando se cobró: un `soldAt` anterior a
            // la apertura no es confiable (SPEC 51).
            await db().collection('cashSessions').doc(session.id)
                .update({ openedAt: Timestamp.fromMillis(daysAgo(6)) });
            const inWindow = await sellWithSaleCoupon(product.id, coupon.code, session.id, {
                offline: true,
                soldAt: new Date(daysAgo(5)).toISOString(),
            });
            expect(inWindow.couponReview).toBeUndefined();
            expect(inWindow.couponDiscountTotal).toBe(50);

            const late = await sellWithSaleCoupon(product.id, coupon.code, session.id, {
                offline: true,
            });
            expect(late.couponReview).toEqual({ reason: 'out_of_window', code: coupon.code });
            expect(late.couponDiscountTotal).toBe(50);
        });

        it('cupón desconocido: se acepta, el descuento queda como manual y se marca', async () => {
            const product = await createProduct(100);
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
                saleDiscountAmount: 10,
                couponCode: 'FANTASMA',
                paymentMethod: 'cash',
                amountReceived: 90,
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
                offline: true,
            });
            expect(sale.total).toBe(90);
            expect(sale.coupon).toBeUndefined();
            expect(sale.couponReview).toEqual({ reason: 'not_found', code: 'FANTASMA' });

            // Un código inventado no salta el tope del 20 %.
            await expectAppError(salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
                saleDiscountAmount: 50,
                couponCode: 'FANTASMA',
                paymentMethod: 'cash',
                amountReceived: 50,
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
                offline: true,
            }), 'FORBIDDEN');
        });
    });

    describe('después de la venta', () => {
        it('devolución con cupón: reembolsa el neto prorrateado y no devuelve el uso', async () => {
            const a = await createProduct(100);
            const b = await createProduct(50);
            const coupon = await saleCoupon(30);
            const session = await openSession('admin-user');
            const sale = await salesService.createSale({
                items: [
                    { productId: a.id, quantity: 2, unitPrice: 100 },
                    { productId: b.id, quantity: 2, unitPrice: 50 },
                ],
                saleDiscountAmount: 30,
                couponCode: coupon.code,
                paymentMethod: 'cash',
                amountReceived: 270,
                cashSessionId: session.id,
                cashierId: 'admin-user',
                roleSlug: 'admin',
            });
            const itemA = productItem(sale, 0);
            const ret = (productId: string, quantity: number) => returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId, quantity }],
                reason: 'No lo quiso',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            });
            const one = await ret(a.id, 1);
            expect(toCents(one.refundTotal)).toBe(Math.round(toCents(itemA.netAmount!) / 2));
            const restA = await ret(a.id, 1);
            expect(toCents(one.refundTotal) + toCents(restA.refundTotal))
                .toBe(toCents(itemA.netAmount!));
            const allB = await ret(b.id, 2);
            expect(toCents(one.refundTotal) + toCents(restA.refundTotal) +
                toCents(allB.refundTotal)).toBe(toCents(sale.total));
            expect((await couponsRepo.getCouponByCode(coupon.code))?.usedCount).toBe(1);
        });

        it('el recibo imprime el cupón (producto en la partida, venta en totales)', async () => {
            const product = await createProduct(100);
            const session = await openSession();
            const perProduct = await productCoupon([product.id], 10);
            const productSale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 100, discountAmount: 10 }],
                couponCode: perProduct.code,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: CASHIER,
            });
            const productReceipt = await receiptsService.getSaleReceipt(productSale.id);
            expect(productReceipt.html).toContain(`Cupón ${perProduct.code} -$10.00`);
            expect(productReceipt.html).not.toContain('Desc.');

            const perSale = await saleCoupon(50);
            const sale = await sellWithSaleCoupon(product.id, perSale.code, session.id);
            const { receipt, html } = await receiptsService.getSaleReceipt(sale.id);
            expect(receipt.coupon).toEqual({
                code: perSale.code, scope: 'sale', discountAmount: 50,
            });
            expect(html).toContain(`Cupón ${perSale.code}`);
            expect(html).toContain('-$50.00');
            expect(html).not.toContain('Desc.');
        });

        it('reportes: couponDiscountTotal en el resumen y exporte "cupones"', async () => {
            const product = await createProduct(100);
            const coupon = await saleCoupon(50);
            const session = await openSession();
            const window = {
                from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            };
            const before = await analyticsService.getSalesSummary(window);
            await sellWithSaleCoupon(product.id, coupon.code, session.id);
            await sellWithSaleCoupon(product.id, coupon.code, session.id);
            const after = await analyticsService.getSalesSummary(window);
            expect(toCents(after.couponDiscountTotal) - toCents(before.couponDiscountTotal))
                .toBe(10000);

            const data = await REPORT_REGISTRY.get('cupones')!.load({
                query: {},
                now: new Date(),
                roleSlug: 'admin',
            });
            const row = data.rows.find((entry) => entry.code === coupon.code);
            expect(row).toMatchObject({ uses: 2, discount: 100, revenue: 100, scope: 'Venta' });
        });
    });
});
