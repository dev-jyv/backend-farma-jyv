import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as customersRepo from '../src/repositories/customers.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import * as salesService from '../src/services/sales.service';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as mercadoPagoService from '../src/services/mercado-pago.service';
import { AppError } from '../src/utils/errors';
import { toTimestamp } from '../src/utils/firestore';
import { productItem } from './sale-item.helpers';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

const getOrderMock = mercadoPagoService.getOrder as jest.MockedFunction<
    typeof mercadoPagoService.getOrder
>;

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const createProductFixture = async (overrides: {
    salePrice?: number;
    requiresPrescription?: boolean;
    isActive?: boolean;
    totalStock?: number;
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
        salePrice: overrides.salePrice ?? 10,
        minStock: 1,
        totalStock: overrides.totalStock ?? 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: overrides.isActive ?? true,
        requiresPrescription: overrides.requiresPrescription ?? false,
        suppliers: [],
    });
};

const stockProduct = async (
    productId: string,
    quantity: number,
    expiryDate = '2027-06-01',
) => {
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

const processedOrder = (overrides: {
    id?: string;
    amount?: string;
    status?: 'processed' | 'created' | 'failed';
} = {}) => ({
    id: overrides.id ?? unique('ORD'),
    status: overrides.status ?? 'processed',
    statusDetail: null,
    terminalId: 'TERM-1',
    amount: overrides.amount ?? '10.00',
    externalReference: 'ref-1',
    paymentId: 'PAY-1',
} as const);

beforeEach(() => {
    getOrderMock.mockReset();
});

describe('sales.service - createSale (FEFO)', () => {
    it('asigna stock del lote que caduca primero y descuenta cantidades', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 15 });
        const session = await openSession();

        const earlyBatch = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-EARLY',
            expiryDate: toTimestamp('2027-01-01'),
            quantity: 5,
        });
        const lateBatch = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-LATE',
            expiryDate: toTimestamp('2027-06-01'),
            quantity: 10,
        });

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 7 }],
            paymentMethod: 'cash',
            amountReceived: 70,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.total).toBe(70);
        expect(sale.change).toBe(0);
        expect(productItem(sale, 0).batchAllocations).toEqual(
            expect.arrayContaining([
                { batchId: earlyBatch.id, quantity: 5 },
                { batchId: lateBatch.id, quantity: 2 },
            ]),
        );

        const updatedEarly = await batchesRepo.getBatchById(earlyBatch.id);
        const updatedLate = await batchesRepo.getBatchById(lateBatch.id);
        expect(updatedEarly!.quantity).toBe(0);
        expect(updatedLate!.quantity).toBe(8);

        const movements = await movementsRepo.listStockMovements({ productId: product.id });
        const saleMovements = movements.filter((m) => m.referenceId === sale.id);
        expect(saleMovements).toHaveLength(2);
        expect(saleMovements.every((m) => m.type === 'sale_adjustment')).toBe(true);
    });

    it('rechaza la venta y no modifica lotes si el stock es insuficiente', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 3 });
        const session = await openSession();

        const batch = await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-CORTO',
            expiryDate: toTimestamp('2027-01-01'),
            quantity: 3,
        });

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 10 }],
                paymentMethod: 'cash',
                amountReceived: 100,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<AppError>);

        const unchanged = await batchesRepo.getBatchById(batch.id);
        expect(unchanged!.quantity).toBe(3);
    });

    it('rechaza venta si el stock disponible está vencido', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 5 });
        const session = await openSession();
        await batchesRepo.createBatch({
            productId: product.id,
            lotNumber: 'LOTE-VENCIDO',
            expiryDate: toTimestamp('2020-01-01'),
            quantity: 5,
        });

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 10,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('vencido'),
        });
    });
});

describe('sales.service - createSale (tender y totales)', () => {
    it('calcula cambio en pago en efectivo', async () => {
        const product = await createProductFixture({ salePrice: 25, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 100,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.subtotal).toBe(50);
        expect(sale.total).toBe(50);
        expect(sale.amountReceived).toBe(100);
        expect(sale.change).toBe(50);
        expect(sale.folio).toMatch(/^V-\d{6}$/);
    });

    it('rechaza efectivo menor al total', async () => {
        const product = await createProductFixture({ salePrice: 40, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 10,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: 'El monto recibido es menor al total de la venta',
        });
    });

    it('aplica descuentos de línea y de venta', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1, discountAmount: 10 }],
            saleDiscountAmount: 5,
            paymentMethod: 'cash',
            amountReceived: 85,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            roleSlug: 'cashier',
        });

        expect(sale.subtotal).toBe(100);
        expect(sale.discountTotal).toBe(15);
        expect(sale.total).toBe(85);
    });

    it('bloquea descuento >20% para roles no admin', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1, discountAmount: 30 }],
                paymentMethod: 'cash',
                amountReceived: 70,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
                roleSlug: 'cashier',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('permite descuento >20% al admin', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1, discountAmount: 50 }],
            paymentMethod: 'cash',
            amountReceived: 50,
            cashSessionId: session.id,
            cashierId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(sale.total).toBe(50);
        expect(sale.discountTotal).toBe(50);
    });
});

describe('sales.service - createSale (receta, cliente, sesión)', () => {
    it('exige receta cuando el producto la requiere', async () => {
        const product = await createProductFixture({
            salePrice: 10,
            totalStock: 1,
            requiresPrescription: true,
        });
        const session = await openSession();
        await stockProduct(product.id, 1);

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 10,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: 'Esta venta requiere datos de receta médica',
        });
    });

    it('guarda receta y cliente cuando se envían', async () => {
        const product = await createProductFixture({
            salePrice: 10,
            totalStock: 1,
            requiresPrescription: true,
        });
        const session = await openSession();
        await stockProduct(product.id, 1);
        const customer = await customersRepo.createCustomer({
            name: unique('Cliente'),
            rfc: 'XAXX010101000',
            phone: '5555555555',
            email: 'cliente@test.com',
        });

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 10,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
            customerId: customer.id,
            prescription: {
                doctorName: 'Dra. Pérez',
                doctorLicense: 'CED-123',
                folio: 'RX-9',
            },
            billing: {
                rfc: 'xaxx010101000',
                name: 'Cliente SA',
                usoCfdi: 'G03',
                email: 'facturas@test.com',
            },
        });

        expect(sale.customerId).toBe(customer.id);
        expect(sale.customerName).toBe(customer.name);
        expect(sale.prescription).toEqual({
            doctorName: 'Dra. Pérez',
            doctorLicense: 'CED-123',
            folio: 'RX-9',
        });
        expect(sale.billing?.rfc).toBe('XAXX010101000');
        expect(sale.invoiceStatus).toBe('pending');
    });

    it('rechaza venta en turno de caja cerrado', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);
        await cashSessionsRepo.closeCashSession(session.id, {
            expectedCashAmount: 0,
            countedCashAmount: 0,
            cashDifference: 0,
            closedBy: 'test-cashier',
            summary: {
                salesCount: 0,
                voidedCount: 0,
                byMethod: {
                    cash: { count: 0, total: 0 },
                    card: { count: 0, total: 0 },
                    transfer: { count: 0, total: 0 },
                    mixed: { count: 0, total: 0 },
                },
                movements: {
                    deposits: { count: 0, total: 0 },
                    withdrawals: { count: 0, total: 0 },
                    expenses: { count: 0, total: 0 },
                },
                grandTotal: 0,
                cashInDrawer: 0,
            },
        });

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 10,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: 'El turno de caja ya está cerrado',
        });
    });
});

describe('sales.service - createSale (pago mixto)', () => {
    const mixedOrder = (amount: string) => ({
        id: unique('ORD'),
        status: 'processed' as const,
        statusDetail: null,
        terminalId: 'TERM-1',
        amount,
        externalReference: 'ref-1',
        paymentId: 'PAY-1',
    } as const);

    it('el efectivo solo cubre la parte que no pagó la tarjeta', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = mixedOrder('60.00');
        getOrderMock.mockResolvedValue(order);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'mixed',
            amountReceived: 40,
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.total).toBe(100);
        expect(sale.cardAmount).toBe(60);
        expect(sale.cashAmount).toBe(40);
        expect(sale.amountReceived).toBe(40);
        expect(sale.change).toBe(0);
    });

    it('el cambio se calcula contra la parte en efectivo, no contra el total', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = mixedOrder('70.00');
        getOrderMock.mockResolvedValue(order);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'mixed',
            amountReceived: 50,
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.cashAmount).toBe(30);
        expect(sale.change).toBe(20);
    });

    it('rechaza cuando el efectivo no alcanza a cubrir su parte', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = mixedOrder('30.00');
        getOrderMock.mockResolvedValue(order);

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'mixed',
                amountReceived: 50,
                cardPaymentReference: order.id,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('no cubre la parte en efectivo'),
        });
    });

    it('si la tarjeta cubre el total, pide registrarla como pago con tarjeta', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = mixedOrder('100.00');
        getOrderMock.mockResolvedValue(order);

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'mixed',
                amountReceived: 10,
                cardPaymentReference: order.id,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('pago con tarjeta'),
        });
    });

    it('solo la parte en efectivo entra al cajón', async () => {
        const product = await createProductFixture({ salePrice: 100, totalStock: 2 });
        const cashier = unique('cajero');
        const session = await openSession(cashier);
        await stockProduct(product.id, 2);
        const order = mixedOrder('60.00');
        getOrderMock.mockResolvedValue(order);

        await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'mixed',
            amountReceived: 100,
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: cashier,
        });

        const { summary } = await cashSessionsService.getSessionSummary(
            session.id,
            cashier,
            'admin',
        );
        // Cobrado 100 (60 tarjeta + 40 efectivo), recibió 100 y se le dieron 60 de cambio.
        expect(summary.cashInDrawer).toBe(40);
        expect(summary.byMethod.mixed.total).toBe(100);
    });

    it('en pago con tarjeta el total va completo a la tarjeta', async () => {
        const product = await createProductFixture({ salePrice: 116, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = mixedOrder('116.00');
        getOrderMock.mockResolvedValue(order);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'card',
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.cardAmount).toBe(116);
        expect(sale.cashAmount).toBeNull();
    });
});

describe('sales.service - createSale (Mercado Pago Point)', () => {
    it('persiste pointPayment cuando la order está processed y el monto coincide', async () => {
        const product = await createProductFixture({ salePrice: 50, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);
        const order = processedOrder({ amount: '50.00' });
        getOrderMock.mockResolvedValue(order);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'card',
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(getOrderMock).toHaveBeenCalledWith(order.id);
        expect(sale.cardPaymentReference).toBe(order.id);
        expect(sale.pointPayment).toEqual({
            orderId: order.id,
            paymentId: 'PAY-1',
            status: 'processed',
            amount: '50.00',
            terminalId: 'TERM-1',
            externalReference: 'ref-1',
        });
        expect(sale.amountReceived).toBeNull();
        expect(sale.change).toBeNull();
    });

    it('rechaza order Point no procesada', async () => {
        const product = await createProductFixture({ salePrice: 20, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);
        const order = processedOrder({ amount: '20.00', status: 'created' });
        getOrderMock.mockResolvedValue(order);

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'card',
                cardPaymentReference: order.id,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('no está pagada'),
        });
    });

    it('rechaza reutilizar una order Point ya asociada a otra venta', async () => {
        const product = await createProductFixture({ salePrice: 15, totalStock: 2 });
        const session = await openSession();
        await stockProduct(product.id, 2);
        const order = processedOrder({ amount: '15.00' });
        getOrderMock.mockResolvedValue(order);

        await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'card',
            cardPaymentReference: order.id,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'card',
                cardPaymentReference: order.id,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rechaza pago card si el monto de la order no coincide', async () => {
        const product = await createProductFixture({ salePrice: 30, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);
        getOrderMock.mockResolvedValue(processedOrder({ amount: '10.00' }));

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'card',
                cardPaymentReference: 'ORD-MISMATCH',
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('no coincide'),
        });
    });
});

describe('sales.service - createSale (idempotencia)', () => {
    it('un retry con la misma llave devuelve la venta original sin descontar stock de nuevo',
        async () => {
            const product = await createProductFixture({ salePrice: 10, totalStock: 10 });
            const session = await openSession();
            const batch = await stockProduct(product.id, 10);
            const payload = {
                idempotencyKey: unique('idem-key'),
                items: [{ productId: product.id, quantity: 3 }],
                paymentMethod: 'cash' as const,
                amountReceived: 30,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            };

            const first = await salesService.createSale(payload);
            const retry = await salesService.createSale(payload);

            expect(retry.id).toBe(first.id);
            expect(retry.folio).toBe(first.folio);
            expect(retry.total).toBe(first.total);

            const afterRetry = await batchesRepo.getBatchById(batch.id);
            expect(afterRetry!.quantity).toBe(7);
            const afterProduct = await productsRepo.getProductById(product.id);
            expect(afterProduct!.totalStock).toBe(7);

            const movements = await movementsRepo.listStockMovements({ productId: product.id });
            expect(movements.filter((movement) => movement.referenceId === first.id))
                .toHaveLength(1);
        });

    it('sin llave de idempotencia dos requests iguales crean dos ventas', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 10 });
        const session = await openSession();
        const batch = await stockProduct(product.id, 10);
        const payload = {
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash' as const,
            amountReceived: 20,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        };

        const first = await salesService.createSale(payload);
        const second = await salesService.createSale(payload);

        expect(second.id).not.toBe(first.id);
        const after = await batchesRepo.getBatchById(batch.id);
        expect(after!.quantity).toBe(6);
    });

    it('rechaza reciclar la llave con un cobro distinto', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 10 });
        const session = await openSession();
        await stockProduct(product.id, 10);
        const key = unique('idem-key');

        await salesService.createSale({
            idempotencyKey: key,
            items: [{ productId: product.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 20,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        await expect(
            salesService.createSale({
                idempotencyKey: key,
                items: [{ productId: product.id, quantity: 5 }],
                paymentMethod: 'cash',
                amountReceived: 50,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
            message: expect.stringContaining('una venta distinta'),
        });
    });

    it('la llave está aislada por cajero', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 10 });
        const key = unique('idem-key');
        await stockProduct(product.id, 10);
        // Un turno por cajero: cada uno solo puede cargar ventas al suyo.
        const sessionA = await openSession('cashier-a');
        const sessionB = await openSession('cashier-b');
        const payload = {
            idempotencyKey: key,
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash' as const,
            amountReceived: 10,
        };

        const cashierA = await salesService.createSale({
            ...payload,
            cashSessionId: sessionA.id,
            cashierId: 'cashier-a',
        });
        const cashierB = await salesService.createSale({
            ...payload,
            cashSessionId: sessionB.id,
            cashierId: 'cashier-b',
        });

        expect(cashierB.id).not.toBe(cashierA.id);
    });

    it('un cajero no puede cargar la venta al turno de otro', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 5 });
        await stockProduct(product.id, 5);
        const session = await openSession('cajero-dueño');

        await expect(
            salesService.createSale({
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 10,
                cashSessionId: session.id,
                cashierId: 'cajero-intruso',
                roleSlug: 'cashier',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('un admin sí puede registrar en el turno de otro', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 5 });
        await stockProduct(product.id, 5);
        const session = await openSession('cajero-dueño');

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 10,
            cashSessionId: session.id,
            cashierId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(sale.cashSessionId).toBe(session.id);
    });

    it('dos requests concurrentes con la misma llave producen una sola venta', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 10 });
        const session = await openSession();
        const batch = await stockProduct(product.id, 10);
        const payload = {
            idempotencyKey: unique('idem-key'),
            items: [{ productId: product.id, quantity: 4 }],
            paymentMethod: 'cash' as const,
            amountReceived: 40,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        };

        const [a, b] = await Promise.all([
            salesService.createSale(payload),
            salesService.createSale(payload),
        ]);

        expect(b.id).toBe(a.id);
        const after = await batchesRepo.getBatchById(batch.id);
        expect(after!.quantity).toBe(6);
    });

    it('un retry con pago Point devuelve la venta original en lugar de chocar con la order',
        async () => {
            const product = await createProductFixture({ salePrice: 15, totalStock: 2 });
            const session = await openSession();
            await stockProduct(product.id, 2);
            const order = processedOrder({ amount: '15.00' });
            getOrderMock.mockResolvedValue(order);
            const payload = {
                idempotencyKey: unique('idem-key'),
                items: [{ productId: product.id, quantity: 1 }],
                paymentMethod: 'card' as const,
                cardPaymentReference: order.id,
                cashSessionId: session.id,
                cashierId: 'test-cashier',
            };

            const first = await salesService.createSale(payload);
            const retry = await salesService.createSale(payload);

            expect(retry.id).toBe(first.id);
            expect(getOrderMock).toHaveBeenCalledTimes(1);
        });
});

describe('sales.service - voidSale', () => {
    it('restaura lotes y marca la venta como anulada', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 5 });
        const session = await openSession();
        const batch = await stockProduct(product.id, 5);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 3 }],
            paymentMethod: 'cash',
            amountReceived: 30,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        const afterSale = await batchesRepo.getBatchById(batch.id);
        expect(afterSale!.quantity).toBe(2);

        const voided = await salesService.voidSale(sale.id, 'admin-user');
        expect(voided.voidedBy).toBe('admin-user');
        expect(voided.voidedAt).toBeTruthy();

        const restored = await batchesRepo.getBatchById(batch.id);
        expect(restored!.quantity).toBe(5);

        const productAfter = await productsRepo.getProductById(product.id);
        expect(productAfter!.totalStock).toBe(5);

        const stored = await salesRepo.getSaleById(sale.id);
        expect(stored!.voidedAt).toBeTruthy();
    });

    it('restaura bien cuando hay varias líneas del mismo producto en un lote', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 10 });
        const session = await openSession();
        const batch = await stockProduct(product.id, 10);

        const sale = await salesService.createSale({
            items: [
                { productId: product.id, quantity: 3 },
                { productId: product.id, quantity: 2 },
            ],
            paymentMethod: 'cash',
            amountReceived: 50,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });

        expect(sale.total).toBe(50);
        const afterSale = await batchesRepo.getBatchById(batch.id);
        expect(afterSale!.quantity).toBe(5);
        const productAfterSale = await productsRepo.getProductById(product.id);
        expect(productAfterSale!.totalStock).toBe(5);

        await salesService.voidSale(sale.id, 'admin-user');

        const restored = await batchesRepo.getBatchById(batch.id);
        expect(restored!.quantity).toBe(10);
        const productAfterVoid = await productsRepo.getProductById(product.id);
        expect(productAfterVoid!.totalStock).toBe(10);
    });

    it('rechaza anular una venta ya anulada', async () => {
        const product = await createProductFixture({ salePrice: 10, totalStock: 1 });
        const session = await openSession();
        await stockProduct(product.id, 1);

        const sale = await salesService.createSale({
            items: [{ productId: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 10,
            cashSessionId: session.id,
            cashierId: 'test-cashier',
        });
        await salesService.voidSale(sale.id, 'admin-user');

        await expect(
            salesService.voidSale(sale.id, 'admin-user'),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: 'La venta ya está anulada',
        });
    });
});

describe('sales.service - assertCanVoidSale', () => {
    const usuario = (slug: string, permisos: Array<{ area: string; level: string }>) =>
        ({ role: { slug }, permissions: permisos }) as Parameters<
            typeof salesService.assertCanVoidSale
        >[0];

    it('el cajero puede anular con `pos:write`, que es lo que realmente tiene', () => {
        // El rol `cashier` NO lleva `sales:write` —eso cubre devoluciones y
        // reembolsos, donde sale dinero hacia el cliente—. Anular sí es rutina de
        // mostrador: el error se detecta con la fila enfrente.
        expect(() =>
            salesService.assertCanVoidSale(usuario('cashier', [{ area: 'pos', level: 'write' }])),
        ).not.toThrow();
    });

    it('también con `sales:write` (roles de administración de ventas)', () => {
        expect(() =>
            salesService.assertCanVoidSale(usuario('manager', [{ area: 'sales', level: 'write' }])),
        ).not.toThrow();
    });

    it('el admin puede aunque no liste el permiso', () => {
        expect(() => salesService.assertCanVoidSale(usuario('admin', []))).not.toThrow();
    });

    it('un rol sin `pos:write` ni `sales:write` no puede', () => {
        expect(() =>
            salesService.assertCanVoidSale(usuario('doctor', [{ area: 'doctor', level: 'write' }])),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
});
