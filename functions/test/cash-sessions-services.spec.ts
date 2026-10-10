import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as serviceProvidersService from '../src/services/service-providers.service';
import * as salesService from '../src/services/sales.service';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as mercadoPagoService from '../src/services/mercado-pago.service';
import { db, now, toTimestamp } from '../src/utils/firestore';

/**
 * Corte de caja con servicios.
 *
 * Las dos cosas que se fijan aquí, en este orden de importancia:
 *
 * 1. **No regresión.** Un turno de ventas viejas —documentos sin
 *    `pharmacyTotal`/`servicesCashAmount`— da exactamente el mismo corte que
 *    antes de existir la rama de servicios, y su resumen ni menciona servicios.
 * 2. El bloque `services` es hermano del de farmacia: el cajón es **uno solo**,
 *    el cajero cuenta el efectivo **una vez** y hay **una** diferencia, contra
 *    la suma de los dos esperados.
 */

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

const getOrderMock = mercadoPagoService.getOrder as jest.MockedFunction<
    typeof mercadoPagoService.getOrder
>;

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const ACTOR = { userId: 'test-admin' };

const abrirTurno = async (openingAmount = 0, openedBy = unique('cajero')) =>
    cashSessionsRepo.createCashSession({
        openedBy,
        openingAmount,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
    });

const crearProducto = async (salePrice: number, quantity: number) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    const producto = await productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice,
        minStock: 1,
        totalStock: quantity,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: false,
        suppliers: [],
    });
    await batchesRepo.createBatch({
        productId: producto.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-06-01'),
        quantity,
        costPrice: 10,
    });
    return producto;
};

const crearServicio = (overrides: Record<string, unknown> = {}) =>
    pharmacyServicesService.createPharmacyService({
        code: unique('SRV'),
        name: unique('Consulta'),
        serviceType: 'consultation',
        price: 250,
        taxMode: 'exempt',
        hasIeps: false,
        commissionRate: 40,
        requiresPerformer: false,
        ...overrides,
    } as Parameters<typeof pharmacyServicesService.createPharmacyService>[0], ACTOR);

/**
 * Venta tal como la escribía el backend **antes** de los servicios: sin
 * `hasServices`, sin la partición farmacia/servicios y sin `commissionTotal`.
 * Se escribe a mano en Firestore porque `createSale` ya no puede producirla.
 */
const ventaHistorica = async (input: {
    cashSessionId: string;
    total: number;
    paymentMethod: 'cash' | 'card' | 'transfer' | 'mixed';
    amountReceived?: number | null;
    change?: number | null;
    /** Se omite a propósito en las más viejas, anteriores al split mixto. */
    cashAmount?: number;
    voided?: boolean;
}) => {
    const doc = {
        folio: unique('V-OLD'),
        productIds: [],
        items: [],
        subtotal: input.total,
        discountTotal: 0,
        total: input.total,
        refundedTotal: 0,
        paymentMethod: input.paymentMethod,
        amountReceived: input.amountReceived ?? null,
        change: input.change ?? null,
        ...(input.cashAmount === undefined ? {} : { cashAmount: input.cashAmount }),
        cardAmount: null,
        cardPaymentReference: null,
        pointPayment: null,
        cashSessionId: input.cashSessionId,
        cashierId: 'cajero-historico',
        customerId: null,
        customerName: null,
        prescription: null,
        billing: null,
        invoiceStatus: null,
        voidedAt: input.voided ? now() : null,
        voidedBy: input.voided ? 'admin-user' : null,
        createdAt: now(),
    };
    await db().collection('sales').add(doc);
    return doc;
};

beforeEach(() => {
    getOrderMock.mockReset();
});

describe('corte de caja - no regresión con ventas históricas', () => {
    it('un turno de ventas viejas da el mismo corte que antes de los servicios', async () => {
        const turno = await abrirTurno(1000);

        // Una venta anterior al split mixto (sin `cashAmount`: recibido − cambio),
        // una de tarjeta y una anulada.
        await ventaHistorica({
            cashSessionId: turno.id,
            total: 100,
            paymentMethod: 'cash',
            amountReceived: 120,
            change: 20,
        });
        await ventaHistorica({
            cashSessionId: turno.id,
            total: 250,
            paymentMethod: 'card',
        });
        await ventaHistorica({
            cashSessionId: turno.id,
            total: 80,
            paymentMethod: 'cash',
            amountReceived: 80,
            change: 0,
            cashAmount: 80,
            voided: true,
        });

        const { summary, expectedCashAmount, expectedServicesCashAmount } =
            await cashSessionsService.getSessionSummary(turno.id, turno.openedBy, 'cashier');

        expect(summary.salesCount).toBe(2);
        expect(summary.voidedCount).toBe(1);
        expect(summary.grandTotal).toBe(350);
        expect(summary.byMethod.cash).toEqual({ count: 1, total: 100 });
        expect(summary.byMethod.card).toEqual({ count: 1, total: 250 });
        // Fondo 1000 + los 100 en efectivo (120 recibidos − 20 de cambio).
        expect(summary.cashInDrawer).toBe(1100);
        expect(expectedCashAmount).toBe(1100);

        // Toda venta histórica es 100 % farmacia: el bloque de servicios no existe.
        expect(summary.services).toBeUndefined();
        expect(expectedServicesCashAmount).toBe(0);
    });

    /**
     * Regresión (QA-4): `round` se añadió con la rama de servicios y la de
     * farmacia se quedó fuera. `expectedCashAmount` es contra lo que el cajero
     * compara el efectivo que cuenta a mano: una fracción de centavo ahí es un
     * descuadre que nadie puede cerrar, porque el cajón no tiene milésimas.
     */
    it('redondea a centavos el efectivo esperado de farmacia', async () => {
        const turno = await abrirTurno(0.1);
        for (const total of [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]) {
            await ventaHistorica({
                cashSessionId: turno.id,
                total,
                paymentMethod: 'cash',
                amountReceived: total,
                change: 0,
                cashAmount: total,
            });
        }

        const { summary, expectedCashAmount } = await cashSessionsService.getSessionSummary(
            turno.id,
            turno.openedBy,
            'cashier',
        );

        // 0.1 × 8 en coma flotante da 0.7999999999999999.
        expect(expectedCashAmount).toBe(0.8);
        expect(summary.cashInDrawer).toBe(0.8);
        expect(summary.grandTotal).toBe(0.7);
    });

    it('cierra un turno histórico con la misma diferencia de siempre', async () => {
        const turno = await abrirTurno(500);
        await ventaHistorica({
            cashSessionId: turno.id,
            total: 200,
            paymentMethod: 'cash',
            amountReceived: 200,
            change: 0,
            cashAmount: 200,
        });

        await cashSessionsService.closeSession(turno.id, turno.openedBy, 'cashier', 650);
        const cerrado = (await cashSessionsRepo.getCashSessionById(turno.id))!;

        expect(cerrado.expectedCashAmount).toBe(700);
        expect(cerrado.expectedServicesCashAmount).toBe(0);
        expect(cerrado.cashDifference).toBeCloseTo(-50, 2);
        expect(cerrado.hasPendingAdjustment).toBe(true);
        expect(cerrado.adjustmentStatus).toBe('pending');
        expect(cerrado.summary?.services).toBeUndefined();
    });
});

describe('corte de caja - bloque de servicios', () => {
    it('separa el efectivo de servicios del de farmacia en una venta mixta', async () => {
        const turno = await abrirTurno(0);
        const producto = await crearProducto(100, 3);
        const doctor = await serviceProvidersService.createServiceProvider({
            name: unique('Dr'),
        });
        const servicio = await crearServicio({ price: 250, commissionRate: 40 });

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 1 },
                { kind: 'service', serviceId: servicio.id, quantity: 1, providerId: doctor.id },
            ],
            paymentMethod: 'cash',
            amountReceived: 350,
            cashSessionId: turno.id,
            cashierId: turno.openedBy,
        });

        const { summary, expectedCashAmount, expectedServicesCashAmount } =
            await cashSessionsService.getSessionSummary(turno.id, turno.openedBy, 'cashier');

        // El corte de farmacia sigue midiendo lo de siempre: la venta completa en
        // `byMethod`, y solo su parte de efectivo en el cajón.
        expect(summary.salesCount).toBe(1);
        expect(summary.byMethod.cash).toEqual({ count: 1, total: 350 });
        expect(summary.cashInDrawer).toBe(100);
        expect(expectedCashAmount).toBe(100);

        expect(summary.services).toEqual({
            count: 1,
            voidedCount: 0,
            byMethod: {
                cash: { count: 1, total: 250 },
                card: { count: 0, total: 0 },
                transfer: { count: 0, total: 0 },
                mixed: { count: 0, total: 0 },
            },
            total: 250,
            commissionTotal: 100,
            cashInDrawer: 250,
        });
        expect(expectedServicesCashAmount).toBe(250);
        // El esperado del cajón es la suma de los dos.
        expect(expectedCashAmount + expectedServicesCashAmount).toBe(350);
    });

    it('una venta con servicios anulada no infla total, comisiones ni efectivo esperado',
        async () => {
            const turno = await abrirTurno(0);
            const servicio = await crearServicio({ price: 250, commissionRate: 40 });

            const venta = await salesService.createSale({
                items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 250,
                cashSessionId: turno.id,
                cashierId: turno.openedBy,
            });
            await salesService.voidSale(venta.id, 'admin-user', 'admin');

            const { summary, expectedCashAmount, expectedServicesCashAmount } =
                await cashSessionsService.getSessionSummary(turno.id, turno.openedBy, 'cashier');

            expect(summary.salesCount).toBe(0);
            expect(summary.voidedCount).toBe(1);
            expect(summary.services).toMatchObject({
                count: 0,
                voidedCount: 1,
                total: 0,
                commissionTotal: 0,
                cashInDrawer: 0,
            });
            expect(expectedCashAmount).toBe(0);
            expect(expectedServicesCashAmount).toBe(0);
        });

    it('el pago con tarjeta suma al total de servicios pero no al efectivo esperado',
        async () => {
            const turno = await abrirTurno(0);
            const servicio = await crearServicio({ price: 250, commissionRate: 0 });
            const order = {
                id: unique('ORD'),
                status: 'processed' as const,
                statusDetail: null,
                terminalId: 'TERM-1',
                amount: '250.00',
                externalReference: 'ref-1',
                paymentId: 'PAY-1',
            } as const;
            getOrderMock.mockResolvedValue(order);

            await salesService.createSale({
                items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
                paymentMethod: 'card',
                cardPaymentReference: order.id,
                cashSessionId: turno.id,
                cashierId: turno.openedBy,
            });

            const { summary, expectedServicesCashAmount } =
                await cashSessionsService.getSessionSummary(turno.id, turno.openedBy, 'cashier');

            expect(summary.services).toMatchObject({
                count: 1,
                total: 250,
                cashInDrawer: 0,
                byMethod: expect.objectContaining({ card: { count: 1, total: 250 } }),
            });
            expect(expectedServicesCashAmount).toBe(0);
        });

    it('el fondo inicial y los movimientos de caja son de farmacia; servicios abre en 0',
        async () => {
            const turno = await abrirTurno(1000);
            const servicio = await crearServicio({ price: 250, commissionRate: 0 });

            await salesService.createSale({
                items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 250,
                cashSessionId: turno.id,
                cashierId: turno.openedBy,
            });
            await cashSessionsService.addMovement(turno.id, turno.openedBy, 'cashier', {
                type: 'expense',
                amount: 100,
                reason: 'Garrafón',
                category: 'supplies',
                description: 'Agua para el mostrador',
            });

            const { expectedCashAmount, expectedServicesCashAmount } =
                await cashSessionsService.getSessionSummary(turno.id, turno.openedBy, 'cashier');

            // 1000 de fondo − 100 de gasto: el gasto sale íntegro de farmacia.
            expect(expectedCashAmount).toBe(900);
            expect(expectedServicesCashAmount).toBe(250);
        });
});

describe('corte de caja - cierre con un solo conteo', () => {
    it('la diferencia se calcula contra la suma de los dos esperados', async () => {
        const turno = await abrirTurno(0);
        const producto = await crearProducto(100, 3);
        const servicio = await crearServicio({ price: 250, commissionRate: 40 });

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 1 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 350,
            cashSessionId: turno.id,
            cashierId: turno.openedBy,
        });

        // El cajero cuenta 350 una sola vez: farmacia (100) + servicios (250).
        const { session, summary } = await cashSessionsService.closeSession(
            turno.id,
            turno.openedBy,
            'cashier',
            350,
        );

        expect(session.cashDifference).toBe(0);
        expect(session.hasPendingAdjustment).toBe(false);
        expect(session.adjustmentStatus).toBeNull();
        expect(session.countedCashAmount).toBe(350);
        expect(session.expectedCashAmount).toBe(100);
        expect(session.expectedServicesCashAmount).toBe(250);
        expect(summary.services).toMatchObject({ total: 250, commissionTotal: 100 });
    });

    it('un faltante sigue dejando un solo ajuste pendiente', async () => {
        const turno = await abrirTurno(0);
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });

        await salesService.createSale({
            items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 250,
            cashSessionId: turno.id,
            cashierId: turno.openedBy,
        });

        const { session } = await cashSessionsService.closeSession(
            turno.id,
            turno.openedBy,
            'cashier',
            200,
        );

        expect(session.cashDifference).toBeCloseTo(-50, 2);
        expect(session.hasPendingAdjustment).toBe(true);
        expect(session.adjustmentStatus).toBe('pending');
    });
});

describe('corte imprimible - bloque SERVICIOS', () => {
    it('la lectura X imprime el bloque solo si hubo servicios', async () => {
        const conServicios = await abrirTurno(0);
        const servicio = await crearServicio({ price: 250, commissionRate: 40 });
        await salesService.createSale({
            items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 250,
            cashSessionId: conServicios.id,
            cashierId: conServicios.openedBy,
        });

        const { html } = await cashSessionsService.buildXReport(
            conServicios.id,
            conServicios.openedBy,
            'cashier',
        );

        expect(html).toContain('SERVICIOS');
        expect(html).toContain('Servicios cobrados');
        expect(html).toContain('Comisiones');
        expect(html).toContain('Efectivo esperado servicios');
        expect(html).toContain('Efectivo esperado (farmacia)');
        expect(html).toContain('Efectivo esperado (total)');
    });

    it('un turno sin servicios imprime el corte de siempre', async () => {
        const turno = await abrirTurno(500);
        await ventaHistorica({
            cashSessionId: turno.id,
            total: 100,
            paymentMethod: 'cash',
            amountReceived: 100,
            change: 0,
            cashAmount: 100,
        });

        const { html } = await cashSessionsService.buildXReport(
            turno.id,
            turno.openedBy,
            'cashier',
        );

        expect(html).not.toContain('SERVICIOS');
        expect(html).toContain('Efectivo esperado');
        expect(html).not.toContain('Efectivo esperado (farmacia)');
    });
});
