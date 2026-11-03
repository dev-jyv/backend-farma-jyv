import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import * as ledgerRepo from '../src/repositories/controlled-ledger.repository';
import * as productsService from '../src/services/products.service';
import * as promotionsService from '../src/services/promotions.service';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as receiptsService from '../src/services/receipts.service';
import { createProductSchema, createSaleSchema, updateProductSchema } from '../src/schemas';
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

/**
 * SPEC 46 — venta por caja completa. El stock, el FEFO, el libro de
 * controlados y la devolución siguen en piezas; la caja solo decide cuántas
 * piezas baja la partida y a qué precio se cobra.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

const baseProduct = (overrides: Record<string, unknown> = {}) => ({
    name: unique('Amoxicilina'),
    sku: unique('SKU'),
    categoryId: category.id,
    unit: 'pieza',
    salePrice: 20,
    minStock: 1,
    hasIva: false,
    hasIvaZero: true,
    hasIeps: false,
    ...overrides,
});

/** Producto con caja de 10 a $180 y dos lotes: el que caduca antes tiene 15 piezas. */
const createBoxProduct = async (overrides: Record<string, unknown> = {}) => {
    const product = await productsService.createProduct({
        ...baseProduct({ boxQuantity: 10, boxPrice: 180, ...overrides }),
    } as Parameters<typeof productsService.createProduct>[0]);
    const early = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('A'),
        expiryDate: toTimestamp('2027-01-01'),
        quantity: 15,
        costPrice: 10,
    });
    const late = await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('B'),
        expiryDate: toTimestamp('2028-01-01'),
        quantity: 30,
        costPrice: 11,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 45 });
    return { product, early, late };
};

const openSession = (userId = 'admin-user') => cashSessionsRepo.createCashSession({
    openedBy: userId,
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

const expectAppError = async (promise: Promise<unknown>, code: string, message?: string) => {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code });
    if (message) {
        expect((error as AppError).message).toContain(message);
    }
};

describe('venta por caja (SPEC 46)', () => {
    describe('esquema del producto', () => {
        it('piezas y precio de caja van juntos', () => {
            expect(createProductSchema.safeParse(baseProduct({ boxQuantity: 10 })).success)
                .toBe(false);
            expect(createProductSchema.safeParse(baseProduct({ boxPrice: 150 })).success)
                .toBe(false);
            expect(createProductSchema.safeParse(
                baseProduct({ boxQuantity: 10, boxPrice: 150 }),
            ).success).toBe(true);
        });

        it('rechaza una caja más cara que sus piezas sueltas, y acepta el empate', () => {
            const over = createProductSchema.safeParse(
                baseProduct({ boxQuantity: 10, boxPrice: 200.01 }),
            );
            expect(over.success).toBe(false);
            expect(JSON.stringify(over)).toContain('no puede ser mayor que 10 piezas');
            expect(createProductSchema.safeParse(
                baseProduct({ boxQuantity: 10, boxPrice: 200 }),
            ).success).toBe(true);
        });

        it('acota piezas por caja a 2–1000 y exige caja para el código de caja', () => {
            expect(createProductSchema.safeParse(
                baseProduct({ boxQuantity: 1, boxPrice: 10 }),
            ).success).toBe(false);
            expect(createProductSchema.safeParse(
                baseProduct({ boxQuantity: 1001, boxPrice: 10 }),
            ).success).toBe(false);
            expect(createProductSchema.safeParse(
                baseProduct({ boxBarcode: '7501234567890' }),
            ).success).toBe(false);
        });

        it('el update quita la caja solo con las dos piezas en null', () => {
            expect(updateProductSchema.safeParse({ boxQuantity: null, boxPrice: null }).success)
                .toBe(true);
            expect(updateProductSchema.safeParse({ boxQuantity: null }).success).toBe(false);
            expect(updateProductSchema.safeParse({ boxBarcode: null }).success).toBe(true);
        });

        it('la partida de venta acepta saleUnit "box" y nada más', () => {
            const sale = (saleUnit: unknown) => createSaleSchema.safeParse({
                items: [{ productId: 'p1', quantity: 1, saleUnit }],
                paymentMethod: 'card',
                cashSessionId: 's1',
            });
            expect(sale('box').success).toBe(true);
            expect(sale('pack').success).toBe(false);
        });
    });

    describe('catálogo', () => {
        it('guarda la caja y la expone en el detalle y en /products/sync', async () => {
            const { product } = await createBoxProduct({ boxBarcode: '17501234567893' });
            const detail = await productsService.getProduct(product.id);
            expect(detail).toMatchObject({
                boxQuantity: 10,
                boxPrice: 180,
                boxBarcode: '17501234567893',
            });

            productsService.clearProductsSyncCache();
            const sync = await productsService.listProductsForSync({});
            expect(sync.items.find((item) => item.id === product.id)).toMatchObject({
                boxQuantity: 10,
                boxPrice: 180,
                boxBarcode: '17501234567893',
            });

            const page = await productsService.listProducts({ search: '17501234567893' });
            expect(page.items.map((item) => item.id)).toContain(product.id);
        });

        it('rechaza un boxBarcode repetido contra barcode, sku y otro boxBarcode', async () => {
            const withBarcode = await productsService.createProduct(
                baseProduct({ barcode: '7500000000011' }) as never,
            );
            await expectAppError(productsService.createProduct(baseProduct({
                boxQuantity: 10, boxPrice: 150, boxBarcode: withBarcode.barcode,
            }) as never), 'CONFLICT', 'código de barras de caja');

            const sku = `${Date.now()}`.slice(-12);
            await productsService.createProduct(baseProduct({ sku }) as never);
            await expectAppError(productsService.createProduct(baseProduct({
                boxQuantity: 10, boxPrice: 150, boxBarcode: sku,
            }) as never), 'CONFLICT');

            await productsService.createProduct(baseProduct({
                boxQuantity: 10, boxPrice: 150, boxBarcode: '17500000000022',
            }) as never);
            await expectAppError(productsService.createProduct(baseProduct({
                boxQuantity: 12, boxPrice: 150, boxBarcode: '17500000000022',
            }) as never), 'CONFLICT');
            // Y al revés: un código de pieza nuevo no puede ser la caja de otro.
            await expectAppError(productsService.createProduct(baseProduct({
                barcode: '17500000000022',
            }) as never), 'CONFLICT', 'código de barras');
        });

        it('una edición de la caja más cara que sus piezas no se guarda', async () => {
            const { product } = await createBoxProduct();
            await expectAppError(
                productsService.updateProduct(product.id, { boxPrice: 201 }, ADMIN),
                'BAD_REQUEST',
                'no puede ser mayor que 10 piezas',
            );
            await expectAppError(
                productsService.updateProduct(
                    product.id,
                    { salePrice: 15, boxQuantity: 10, boxPrice: 180 },
                    ADMIN,
                ),
                'BAD_REQUEST',
            );
            expect((await productsRepo.getProductById(product.id))?.boxPrice).toBe(180);
        });

        it('bajar solo salePrice bajo la caja se acepta y queda en bitácora (POS offline)',
            async () => {
                const { product } = await createBoxProduct();
                const updated = await productsService.updateProduct(
                    product.id,
                    { salePrice: 17 },
                    ADMIN,
                );
                expect(updated.salePrice).toBe(17);
                expect(updated).toMatchObject({ boxQuantity: 10, boxPrice: 180 });

                const bulk = await createBoxProduct();
                const [bulkUpdated] = await productsService.updateProductPrices(
                    [{ productId: bulk.product.id, salePrice: 16 }],
                    ADMIN,
                );
                expect(bulkUpdated.salePrice).toBe(16);

                for (const id of [product.id, bulk.product.id]) {
                    const logs = await auditRepo.listAuditLogs({ entityId: id });
                    const review = logs.find((log) => log.action === 'product.box_price_review');
                    expect(review?.summary).toContain('más cara');
                }

                // Una subida que deja la caja bien no deja marca.
                const fine = await createBoxProduct();
                await productsService.updateProduct(fine.product.id, { salePrice: 25 }, ADMIN);
                const fineLogs = await auditRepo.listAuditLogs({ entityId: fine.product.id });
                expect(fineLogs.map((log) => log.action)).not.toContain('product.box_price_review');
            });

        it('cambiar el precio de caja se audita como cambio de precio', async () => {
            const { product } = await createBoxProduct();
            await productsService.updateProduct(product.id, { boxPrice: 175 }, ADMIN);
            const logs = await auditRepo.listAuditLogs({ entityId: product.id });
            const priceLog = logs.find((log) => log.action === 'product.price_changed');
            expect(priceLog?.summary).toContain('Precio de caja');
            expect(priceLog?.changes).toMatchObject({ boxPrice: { before: 180, after: 175 } });
        });

        it('null quita la caja del documento', async () => {
            const { product } = await createBoxProduct({ boxBarcode: '17500000000039' });
            const updated = await productsService.updateProduct(
                product.id,
                { boxQuantity: null, boxPrice: null, boxBarcode: null },
                ADMIN,
            );
            expect(updated.boxQuantity).toBeUndefined();
            const raw = (await db().collection('products').doc(product.id).get()).data()!;
            expect(raw).not.toHaveProperty('boxQuantity');
            expect(raw).not.toHaveProperty('boxPrice');
            expect(raw).not.toHaveProperty('boxBarcode');
        });
    });

    describe('venta', () => {
        it('2 cajas de 10 bajan 20 piezas por FEFO y cobran 2 × boxPrice', async () => {
            const { product, early, late } = await createBoxProduct();
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, unitPrice: 180, saleUnit: 'box' }],
                paymentMethod: 'cash',
                amountReceived: 360,
                cashSessionId: session.id,
                cashierId: 'admin-user',
                roleSlug: 'cashier',
            });

            expect(sale.total).toBe(360);
            const item = productItem(sale);
            expect(item.quantity).toBe(20);
            expect(item.subtotal).toBe(360);
            expect(item.unitPrice).toBe(18);
            expect(item.catalogUnitPrice).toBeUndefined();
            expect(item.saleUnit).toEqual({
                type: 'box', boxes: 2, piecesPerBox: 10, boxPrice: 180,
            });
            expect(item.batchAllocations).toEqual([
                { batchId: early.id, quantity: 15 },
                { batchId: late.id, quantity: 5 },
            ]);
            expect(item.costAmount).toBe(15 * 10 + 5 * 11);

            const [earlyAfter, lateAfter, productAfter] = await Promise.all([
                batchesRepo.getBatchById(early.id),
                batchesRepo.getBatchById(late.id),
                productsRepo.getProductById(product.id),
            ]);
            expect(earlyAfter?.quantity).toBe(0);
            expect(lateAfter?.quantity).toBe(25);
            expect(productAfter?.totalStock).toBe(25);

            // `mapSale` es una lista blanca: el saleUnit tiene que sobrevivir la lectura.
            const read = await salesRepo.getSaleById(sale.id);
            expect(productItem(read!).saleUnit).toEqual(item.saleUnit);
        });

        it('sin unitPrice cobra el boxPrice; con otro precio deja catalogUnitPrice', async () => {
            const { product } = await createBoxProduct();
            const session = await openSession();
            const catalog = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            });
            expect(catalog.total).toBe(180);

            const charged = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, unitPrice: 170, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            });
            expect(charged.total).toBe(170);
            expect(productItem(charged).catalogUnitPrice).toBe(180);
            expect(productItem(charged).saleUnit?.boxPrice).toBe(170);
        });

        it('base + iva + ieps === neto al centavo en una línea por caja', async () => {
            const { product } = await createBoxProduct({
                salePrice: 15.37,
                boxQuantity: 12,
                boxPrice: 175.55,
                hasIva: true,
                hasIvaZero: false,
                hasIeps: true,
                iepsRate: 0.08,
            });
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 3,
                    unitPrice: 175.55,
                    saleUnit: 'box',
                    discountAmount: 7.13,
                }],
                saleDiscountAmount: 3.01,
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
                roleSlug: 'admin',
            });
            const item = productItem(sale);
            expect(item.quantity).toBe(36);
            expect(item.subtotal).toBe(526.65);
            const taxes = item.taxes!;
            expect(toCents(taxes.base) + toCents(taxes.ivaAmount) + toCents(taxes.iepsAmount))
                .toBe(toCents(item.netAmount!));
            expect(toCents(sale.total)).toBe(toCents(526.65 - 7.13 - 3.01));
            expect(toCents(sale.taxSummary!.total)).toBe(toCents(sale.total));
        });

        it('una caja y piezas sueltas del mismo producto son dos partidas', async () => {
            const { product } = await createBoxProduct();
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [
                    { productId: product.id, quantity: 1, unitPrice: 180, saleUnit: 'box' },
                    { productId: product.id, quantity: 3, unitPrice: 20 },
                ],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            });
            expect(sale.total).toBe(240);
            expect(productItem(sale, 0).quantity).toBe(10);
            expect(productItem(sale, 1).quantity).toBe(3);
            expect(productItem(sale, 1).saleUnit).toBeUndefined();
            expect((await productsRepo.getProductById(product.id))?.totalStock).toBe(32);
        });

        it('una promoción en una línea por caja da 400', async () => {
            const { product } = await createBoxProduct();
            const promo = await promotionsService.createPromotion({
                name: '2x1',
                rule: { type: 'nxm', buy: 2, pay: 1 },
                productIds: [product.id],
            }, ADMIN);
            const session = await openSession();
            await expectAppError(salesService.createSale({
                items: [{
                    productId: product.id,
                    quantity: 2,
                    unitPrice: 180,
                    saleUnit: 'box',
                    promotionId: promo.id,
                }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            }), 'BAD_REQUEST', 'Las promociones no aplican a la venta por caja');
        });

        it('un producto sin caja configurada vendido por caja da 400', async () => {
            const product = await productsService.createProduct(baseProduct() as never);
            await batchesRepo.createBatch({
                productId: product.id,
                lotNumber: unique('L'),
                expiryDate: toTimestamp('2028-01-01'),
                quantity: 40,
                costPrice: 5,
            });
            const session = await openSession();
            await expectAppError(salesService.createSale({
                items: [{ productId: product.id, quantity: 1, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            }), 'BAD_REQUEST', 'no tiene configurada la venta por caja');
        });

        it('stock menor a una caja: falta de stock, como siempre', async () => {
            const { product } = await createBoxProduct({ boxQuantity: 50, boxPrice: 900 });
            const session = await openSession();
            await expectAppError(salesService.createSale({
                items: [{ productId: product.id, quantity: 1, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            }), 'BAD_REQUEST', 'Stock insuficiente');
        });

        it('un controlado vendido por caja entra al libro en piezas', async () => {
            const { product } = await createBoxProduct({ controlledGroup: 'IV' });
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
                prescription: { doctorName: 'Dra. Pérez', doctorLicense: '1234567' },
            });
            const ledger = await ledgerRepo.listLedgerEntries({ saleId: sale.id });
            expect(ledger).toHaveLength(1);
            expect(ledger[0].quantity).toBe(20);
        });

        it('la huella incluye saleUnit: misma llave con piezas sueltas es CONFLICT', async () => {
            const { product } = await createBoxProduct({ boxPrice: 200 });
            const session = await openSession();
            const key = unique('idem-box');
            const send = (box: boolean) => salesService.createSale({
                idempotencyKey: key,
                items: [box
                    ? { productId: product.id, quantity: 1, unitPrice: 200, saleUnit: 'box' }
                    : { productId: product.id, quantity: 10, unitPrice: 20 }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            });
            const first = await send(true);
            const replay = await send(true);
            expect(replay.id).toBe(first.id);
            await expectAppError(send(false), 'CONFLICT');
        });

        it('el recibo imprime cajas y piezas', async () => {
            const { product } = await createBoxProduct();
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 2, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            });
            const { receipt, html } = await receiptsService.getSaleReceipt(sale.id);
            expect(receipt.lines[0].saleUnit).toMatchObject({ boxes: 2, piecesPerBox: 10 });
            expect(html).toContain('2 cajas × 10 pzas x $180.00');
            expect(html).toContain('$360.00');
        });

        it('quitar la caja del producto no toca las ventas ya hechas', async () => {
            const { product } = await createBoxProduct();
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 1, saleUnit: 'box' }],
                paymentMethod: 'card',
                cashSessionId: session.id,
                cashierId: 'admin-user',
            });
            await productsService.updateProduct(
                product.id,
                { boxQuantity: null, boxPrice: null },
                ADMIN,
            );
            const read = await salesRepo.getSaleById(sale.id);
            expect(productItem(read!).saleUnit?.boxes).toBe(1);
        });
    });

    describe('devolución', () => {
        it('devolver una caja completa reembolsa boxPrice; el resto, el remanente', async () => {
            const { product } = await createBoxProduct({
                salePrice: 15.37,
                boxQuantity: 12,
                boxPrice: 175.55,
            });
            const session = await openSession();
            const sale = await salesService.createSale({
                items: [{ productId: product.id, quantity: 3, saleUnit: 'box' }],
                paymentMethod: 'cash',
                amountReceived: 600,
                cashSessionId: session.id,
                cashierId: 'admin-user',
                roleSlug: 'admin',
            });
            expect(sale.total).toBe(526.65);

            const ret = (quantity: number) => returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity }],
                reason: 'Devolución de caja',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            });
            const oneBox = await ret(12);
            expect(oneBox.refundTotal).toBe(175.55);
            // Piezas sueltas de una línea por caja: proporcional.
            const fivePieces = await ret(5);
            expect(fivePieces.refundTotal).toBe(Math.round((52665 * 5) / 36) / 100);
            const rest = await ret(19);
            expect(toCents(oneBox.refundTotal) + toCents(fivePieces.refundTotal) +
                toCents(rest.refundTotal)).toBe(52665);
        });
    });
});
