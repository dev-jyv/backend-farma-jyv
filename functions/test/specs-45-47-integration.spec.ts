import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import * as couponsService from '../src/services/coupons.service';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import { REPORT_KEYS } from '../src/services/report-export/registry';
import {
    REPORT_DOWNLOAD_KEYS,
    exportReport,
    previewReport,
} from '../src/services/report-export/export-report';
import { AppError } from '../src/utils/errors';
import { toTimestamp } from '../src/utils/firestore';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

/**
 * Integración SPEC 45 × SPEC 46/47: el exporte `cupones` (SPEC 47) queda fuera
 * de lo que abre `reportDownloads` (SPEC 45), y la vista previa `format=json`
 * funciona con ventas por caja y con cupón sin romper las filas de `ventas`.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };
const CASHIER = 'int-cashier';
const CONTADOR = {
    roleSlug: 'accountant',
    permissions: [{ area: 'reportDownloads' as const, level: 'read' as const }],
};
let seq = 0;
const newCode = () => `INT-${Date.now().toString(36).toUpperCase().slice(-6)}${seq++}`;

const createBoxProduct = async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsService.createProduct({
        name: unique('Amoxicilina'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 20,
        minStock: 1,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        boxQuantity: 10,
        boxPrice: 180,
    } as Parameters<typeof productsService.createProduct>[0]);
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('L'),
        expiryDate: toTimestamp('2028-01-01'),
        quantity: 100,
        costPrice: 10,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 100 });
    return product;
};

const openSession = () => cashSessionsRepo.createCashSession({
    openedBy: CASHIER,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const statusOf = (promise: Promise<unknown>) =>
    promise.then(() => 200, (error: unknown) => (error as AppError).statusCode);

describe('integración SPEC 45 × 46/47', () => {
    it('el contador no abre `cupones`, ni como json ni como archivo', async () => {
        expect(REPORT_KEYS).toContain('cupones');
        expect(REPORT_DOWNLOAD_KEYS).not.toContain('cupones');
        expect(await statusOf(previewReport({ report: 'cupones', query: {}, ...CONTADOR })))
            .toBe(403);
        expect(await statusOf(exportReport({
            report: 'cupones',
            format: 'csv',
            query: {},
            generatedBy: 'Contador',
            ...CONTADOR,
        }))).toBe(403);
    });

    it('vista previa de `cupones` y `ventas` con cajas y cupones: filas y totales en pesos',
        async () => {
            const product = await createBoxProduct();
            const session = await openSession();
            const perProduct = await couponsService.createCoupon({
                code: newCode(),
                name: 'Cupón producto',
                scope: 'product',
                productIds: [product.id],
                discount: { type: 'percent', percent: 10 },
            }, ADMIN);
            const perSale = await couponsService.createCoupon({
                code: newCode(),
                name: 'Cupón venta',
                scope: 'sale',
                discount: { type: 'amount', amount: 50 },
            }, ADMIN);

            // 2 cajas de $180 con 10 % por producto: el cupón va dentro de la partida.
            const boxSale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 180,
                    saleUnit: 'box',
                    discountAmount: 36,
                }],
                couponCode: perProduct.code,
                paymentMethod: 'cash',
                amountReceived: 324,
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
            });
            expect(boxSale.total).toBe(324);
            expect(productItem(boxSale).quantity).toBe(20);
            expect(productItem(boxSale).coupon).toEqual({
                couponId: perProduct.id, discountAmount: 36,
            });

            // 1 caja con $50 de cupón de venta: va en saleDiscountAmount.
            const saleCouponSale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 180, saleUnit: 'box' }],
                saleDiscountAmount: 50,
                couponCode: perSale.code,
                paymentMethod: 'cash',
                amountReceived: 130,
                cashSessionId: session.id,
                cashierId: CASHIER,
                roleSlug: 'cashier',
            });
            expect(saleCouponSale.total).toBe(130);

            // `mapSale` conserva saleUnit, coupon y los campos de cupón de la venta.
            const read = await salesRepo.getSaleById(boxSale.id);
            expect(productItem(read!).saleUnit).toEqual({
                type: 'box', boxes: 2, piecesPerBox: 10, boxPrice: 180,
            });
            expect(read!.coupon).toMatchObject({ code: perProduct.code, scope: 'product' });
            expect(read!.couponDiscountTotal).toBe(36);

            const cupones = await previewReport({ report: 'cupones', query: {}, ...ADMIN });
            const byCode = new Map(cupones.rows.map((row) => [row.code, row]));
            expect(byCode.get(perProduct.code)).toMatchObject({
                scope: 'Producto', uses: 1, discount: 36, revenue: 324, review: 0,
            });
            expect(byCode.get(perSale.code)).toMatchObject({
                scope: 'Venta', uses: 1, discount: 50, revenue: 130, review: 0,
            });
            expect(cupones.totals).toEqual({ uses: 2, discount: 86, revenue: 454, review: 0 });

            const ventas = await previewReport({
                report: 'ventas',
                query: { scope: 'pharmacy' },
                ...CONTADOR,
            });
            const rows = new Map(ventas.rows.map((row) => [row.folio, row]));
            expect(rows.get(boxSale.folio)).toMatchObject({ amount: 324 });
            expect(String(rows.get(boxSale.folio)!.concept)).toContain('20×');
            expect(rows.get(saleCouponSale.folio)).toMatchObject({ amount: 130 });
            expect(ventas.totals).toEqual({ amount: 454 });
        });
});
