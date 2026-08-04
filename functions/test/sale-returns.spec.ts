import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as receiptsService from '../src/services/receipts.service';
import * as mercadoPagoService from '../src/services/mercado-pago.service';
import { toTimestamp } from '../src/utils/firestore';
import { toCents } from '../src/utils/taxes';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

const getOrderMock = mercadoPagoService.getOrder as jest.MockedFunction<
    typeof mercadoPagoService.getOrder
>;
const refundOrderMock = mercadoPagoService.refundOrder as jest.MockedFunction<
    typeof mercadoPagoService.refundOrder
>;

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const createProductFixture = async (overrides: {
    salePrice?: number;
    hasIva?: boolean;
    hasIvaZero?: boolean;
    hasIeps?: boolean;
    iepsRate?: number;
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
        salePrice: overrides.salePrice ?? 116,
        minStock: 1,
        totalStock: 0,
        hasIva: overrides.hasIva ?? true,
        hasIvaZero: overrides.hasIvaZero ?? false,
        hasIeps: overrides.hasIeps ?? false,
        ...(overrides.iepsRate !== undefined ? { iepsRate: overrides.iepsRate } : {}),
        isActive: true,
        requiresPrescription: false,
        suppliers: [],
    });
};

const stockProduct = async (productId: string, quantity: number, expiryDate = '2027-06-01') => {
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

beforeEach(() => {
    getOrderMock.mockReset();
    refundOrderMock.mockReset();
});

describe('sales.service - desglose de impuestos', () => {
    it('desglosa IVA por partida y el resumen cuadra con el total cobrado', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession();
        await stockProduct(product.id, 5);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 232,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.items[0].netAmount).toBe(232);
        expect(sale.items[0].taxes).toEqual({
            base: 200,
            ivaRate: 0.16,
            ivaAmount: 32,
            iepsRate: 0,
            iepsAmount: 0,
        });
        expect(sale.taxSummary).toEqual({
            base: 200,
            ivaTotal: 32,
            iepsTotal: 0,
            taxTotal: 32,
            total: 232,
        });
        expect(sale.taxSummary!.total).toBe(sale.total);
    });

    it('prorratea el descuento de venta antes de calcular impuestos', async () => {
        const productA = await createProductFixture({ salePrice: 100 });
        const productB = await createProductFixture({ salePrice: 300 });
        const session = await openSession();
        await stockProduct(productA.id, 1);
        await stockProduct(productB.id, 1);

        const sale = await salesService.createSale({
            items: [
                { productId: productA.id, quantity: 1 },
                { productId: productB.id, quantity: 1 },
            ],
            saleDiscountAmount: 40,
            paymentMethod: 'cash',
            amountReceived: 360,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            roleSlug: 'admin',
        });

        expect(sale.items.map((item) => item.saleDiscountShare)).toEqual([10, 30]);
        expect(sale.items.map((item) => item.netAmount)).toEqual([90, 270]);
        // El IVA se declara sobre lo cobrado (360), no sobre el precio de lista.
        expect(sale.taxSummary!.total).toBe(360);
        expect(toCents(sale.taxSummary!.base + sale.taxSummary!.taxTotal)).toBe(toCents(360));
    });

    it('aplica IEPS con la tasa del producto', async () => {
        const product = await createProductFixture({
            salePrice: 125.28,
            hasIeps: true,
            iepsRate: 0.08,
        });
        const session = await openSession();
        await stockProduct(product.id, 1);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 130,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.taxSummary).toMatchObject({ base: 100, ivaTotal: 17.28, iepsTotal: 8 });
    });

    it('rechaza vender un producto con IEPS sin tasa configurada', async () => {
        const product = await createProductFixture({ salePrice: 100, hasIeps: true });
        const session = await openSession();
        await stockProduct(product.id, 1);

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
            message: expect.stringContaining('IEPS sin tasa'),
        });
    });
});

describe('sale-returns.service - createSaleReturn', () => {
    const sellTwo = async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession();
        const batch = await stockProduct(product.id, 10);
        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 4 }],
            paymentMethod: 'cash',
            amountReceived: 464,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });
        return { product, session, batch, sale };
    };

    it('reingresa al lote de origen, registra return_in y desglosa impuestos', async () => {
        const { product, session, batch, sale } = await sellTwo();

        const saleReturn = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Producto equivocado',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(saleReturn.folio).toMatch(/^D-\d{6}$/);
        expect(saleReturn.refundTotal).toBe(116);
        expect(saleReturn.refundMethod).toBe('cash');
        expect(saleReturn.taxSummary).toMatchObject({ base: 100, ivaTotal: 16 });
        expect(saleReturn.items[0].batchAllocations).toEqual([
            { batchId: batch.id, quantity: 1 },
        ]);

        const afterBatch = await batchesRepo.getBatchById(batch.id);
        expect(afterBatch!.quantity).toBe(7);
        const afterProduct = await productsRepo.getProductById(product.id);
        expect(afterProduct!.totalStock).toBe(7);

        const movements = await movementsRepo.listStockMovements({ productId: product.id });
        const returnMovements = movements.filter((movement) => movement.type === 'return_in');
        expect(returnMovements).toHaveLength(1);
        expect(returnMovements[0].quantity).toBe(1);
        expect(returnMovements[0].referenceId).toBe(saleReturn.id);

        const afterSale = await salesRepo.getSaleById(sale.id);
        expect(afterSale!.refundedTotal).toBe(116);
    });

    it('no permite devolver más unidades de las vendidas, sumando devoluciones previas',
        async () => {
            const { product, session, sale } = await sellTwo();

            await returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity: 3 }],
                reason: 'Devolución parcial',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            });

            await expect(
                returnsService.createSaleReturn({
                    saleId: sale.id,
                    items: [{ productId: product.id, quantity: 2 }],
                    reason: 'Segunda devolución',
                    cashSessionId: session.id,
                    userId: 'admin-user',
                    roleSlug: 'admin',
                }),
            ).rejects.toMatchObject({
                code: 'BAD_REQUEST',
                message: expect.stringContaining('Solo quedan 1'),
            });
        });

    it('reparte el reingreso entre los lotes de origen respetando FEFO', async () => {
        const product = await createProductFixture({ salePrice: 100 });
        const session = await openSession();
        const early = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-EARLY',
            expiryDate: toTimestamp('2027-01-01'),
            quantity: 2,
        });
        const late = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-LATE',
            expiryDate: toTimestamp('2027-09-01'),
            quantity: 5,
        });
        await productsRepo.updateProduct(product.id, { totalStock: 7 });

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 4 }],
            paymentMethod: 'cash',
            amountReceived: 400,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        const saleReturn = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 3 }],
            reason: 'Devolución mixta',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(saleReturn.items[0].batchAllocations).toEqual([
            { batchId: early.id, quantity: 2 },
            { batchId: late.id, quantity: 1 },
        ]);
        expect((await batchesRepo.getBatchById(early.id))!.quantity).toBe(2);
        expect((await batchesRepo.getBatchById(late.id))!.quantity).toBe(4);
    });

    it('devolver el resto paga el remanente exacto sin perder centavos', async () => {
        const product = await createProductFixture({ salePrice: 10 });
        const session = await openSession();
        await stockProduct(product.id, 3);
        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 3 }],
            saleDiscountAmount: 0.01,
            paymentMethod: 'cash',
            amountReceived: 30,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        const first = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Parcial',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });
        const second = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 2 }],
            reason: 'Resto',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(toCents(first.refundTotal + second.refundTotal)).toBe(toCents(sale.total));
    });

    it('reembolsa la order Point con llave de idempotencia estable', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = {
            id: unique('ORD'),
            status: 'processed' as const,
            statusDetail: null,
            terminalId: 'TERM-1',
            amount: '232.00',
            externalReference: 'ref-1',
            paymentId: 'PAY-1',
        };
        getOrderMock.mockResolvedValue(order);
        refundOrderMock.mockResolvedValue({ ...order, status: 'refunded' as const });

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'card',
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        const saleReturn = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Cliente cambió de opinión',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(saleReturn.refundMethod).toBe('card');
        expect(saleReturn.pointRefund).toMatchObject({ orderId: order.id, amount: 116 });
        expect(refundOrderMock).toHaveBeenCalledWith(expect.objectContaining({
            orderId: order.id,
            paymentId: 'PAY-1',
            amount: 116,
            idempotencyKey: expect.stringMatching(/^refund:[a-f0-9]{64}$/),
        }));
    });

    it('exige método de reembolso explícito en ventas mixtas', async () => {
        const product = await createProductFixture({ salePrice: 100 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = {
            id: unique('ORD'),
            status: 'processed' as const,
            statusDetail: null,
            terminalId: 'TERM-1',
            amount: '50.00',
            externalReference: 'ref-1',
            paymentId: 'PAY-1',
        };
        getOrderMock.mockResolvedValue(order);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'mixed',
            // `resolveTender` exige hoy que el efectivo recibido cubra el total
            // completo incluso en pago mixto (ver nota en GOALS.md).
            amountReceived: 100,
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        await expect(
            returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity: 1 }],
                reason: 'Sin método',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('método de reembolso'),
        });
    });

    it('un retry con la misma llave no duplica la devolución', async () => {
        const { product, session, batch, sale } = await sellTwo();
        const payload = {
            idempotencyKey: unique('idem-return'),
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 2 }],
            reason: 'Retry',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        };

        const first = await returnsService.createSaleReturn(payload);
        const retry = await returnsService.createSaleReturn(payload);

        expect(retry.id).toBe(first.id);
        expect((await batchesRepo.getBatchById(batch.id))!.quantity).toBe(8);
        expect((await salesRepo.getSaleById(sale.id))!.refundedTotal).toBe(232);
    });

    it('solo admin o gerente pueden devolver', async () => {
        const { product, session, sale } = await sellTwo();

        await expect(
            returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity: 1 }],
                reason: 'Sin permiso',
                cashSessionId: session.id,
                userId: 'cashier-user',
                roleSlug: 'cashier',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rechaza devolver sobre un turno cerrado', async () => {
        const { product, session, sale } = await sellTwo();
        await cashSessionsService.closeSession(session.id, 'test-cashier', 'admin', 464);

        await expect(
            returnsService.createSaleReturn({
                saleId: sale.id,
                items: [{ productId: product.id, quantity: 1 }],
                reason: 'Turno cerrado',
                cashSessionId: session.id,
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('turno de caja ya está cerrado'),
        });
    });

    it('no permite anular una venta que ya tiene devoluciones', async () => {
        const { product, session, sale } = await sellTwo();
        await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Parcial',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        await expect(salesService.voidSale(sale.id, 'admin-user')).rejects.toMatchObject({
            code: 'CONFLICT',
            message: expect.stringContaining('devoluciones registradas'),
        });
    });

    it('el efectivo devuelto sale del cajón en el corte', async () => {
        const { product, session, sale } = await sellTwo();

        const before = await cashSessionsService.getSessionSummary(
            session.id,
            'test-cashier',
            'admin',
        );
        expect(before.summary.cashInDrawer).toBe(464);

        await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Devolución en efectivo',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const after = await cashSessionsService.getSessionSummary(
            session.id,
            'test-cashier',
            'admin',
        );
        expect(after.summary.cashInDrawer).toBe(348);
        expect(after.summary.returns).toEqual({ count: 1, total: 116, cashTotal: 116 });
        expect(after.summary.grandTotal).toBe(348);
    });
});

describe('receipts.service', () => {
    it('arma el ticket de venta con impuestos agrupados por tasa', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 150,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        const { receipt, html } = await receiptsService.getSaleReceipt(sale.id, 58);

        expect(receipt.kind).toBe('sale');
        expect(receipt.folio).toBe(sale.folio);
        expect(receipt.total).toBe(116);
        expect(receipt.taxBase).toBe(100);
        expect(receipt.taxes).toEqual([{ label: 'IVA', rate: 0.16, amount: 16 }]);
        expect(receipt.change).toBe(34);
        expect(html).toContain('@page { size: 58mm auto; margin: 0; }');
        expect(html).toContain('IVA 16%');
    });

    it('marca el ticket de una venta anulada y respeta el ancho de 80mm', async () => {
        const product = await createProductFixture({ salePrice: 50 });
        const session = await openSession();
        await stockProduct(product.id, 1);
        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 50,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });
        await salesService.voidSale(sale.id, 'admin-user');

        const { receipt, html } = await receiptsService.getSaleReceipt(sale.id, 80);
        expect(receipt.voided).toBe(true);
        expect(receipt.notes).toContain('VENTA ANULADA');
        expect(html).toContain('size: 80mm auto');
    });

    it('arma el ticket de la devolución apuntando a la venta original', async () => {
        const product = await createProductFixture({ salePrice: 116 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 232,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });
        const saleReturn = await returnsService.createSaleReturn({
            saleId: sale.id,
            items: [{ productId: product.id, quantity: 1 }],
            reason: 'Caja abierta',
            cashSessionId: session.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const { receipt, html } = await receiptsService.getSaleReturnReceipt(saleReturn.id);

        expect(receipt.kind).toBe('return');
        expect(receipt.total).toBe(116);
        expect(receipt.notes).toContain(`Devolución de la venta ${sale.folio}`);
        expect(receipt.notes).toContain('Motivo: Caja abierta');
        expect(html).toContain('DEVUELTO');
    });
});
