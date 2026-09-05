import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as controlledService from '../src/services/controlled.service';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as serviceProvidersService from '../src/services/service-providers.service';
import * as salesService from '../src/services/sales.service';
import * as returnsService from '../src/services/sale-returns.service';
import * as mercadoPagoService from '../src/services/mercado-pago.service';
import { createSaleSchema } from '../src/schemas';
import { toCents } from '../src/utils/taxes';
import { toTimestamp } from '../src/utils/firestore';
import { productItem, productItems, serviceItem, serviceItems } from './sale-item.helpers';

/**
 * Cobro de servicios en la **misma venta** que la mercancía.
 *
 * Lo que se fija aquí:
 *
 * 1. La rama de mercancía no cambia: FEFO, lotes, movimientos de stock y libro
 *    de controlados siguen igual. Una venta 100 % producto es idéntica a la de
 *    antes de existir los servicios.
 * 2. La rama de servicio no toca inventario y **congela** la comisión: el
 *    catálogo puede cambiar mañana, la venta ya está cobrada.
 * 3. El efectivo se reparte con la regla **servicios primero**, y las dos ramas
 *    siempre suman el total y el efectivo de la venta.
 * 4. Un payload **sin `kind`** sigue siendo una venta de mercancía: el POS ya
 *    instalado los manda así y hay ventas encoladas offline con ese formato.
 */

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

const getOrderMock = mercadoPagoService.getOrder as jest.MockedFunction<
    typeof mercadoPagoService.getOrder
>;

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const ACTOR = { userId: 'test-admin' };

const crearProducto = async (overrides: {
    salePrice?: number;
    controlledGroup?: 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI';
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
        salePrice: overrides.salePrice ?? 100,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: false,
        ...(overrides.controlledGroup ? { controlledGroup: overrides.controlledGroup } : {}),
        suppliers: [],
    });
};

const surtir = async (productId: string, quantity: number) => {
    const batch = await batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-06-01'),
        quantity,
        costPrice: 50,
    });
    await productsRepo.updateProduct(productId, { totalStock: quantity });
    return batch;
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

const crearDoctor = (overrides: Record<string, unknown> = {}) =>
    serviceProvidersService.createServiceProvider({
        name: unique('Dr'),
        ...overrides,
    } as Parameters<typeof serviceProvidersService.createServiceProvider>[0]);

const abrirTurno = async (openedBy: string) =>
    cashSessionsRepo.createCashSession({
        openedBy,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
    });

const orderProcesada = (amount: string) => ({
    id: unique('ORD'),
    status: 'processed' as const,
    statusDetail: null,
    terminalId: 'TERM-1',
    amount,
    externalReference: 'ref-1',
    paymentId: 'PAY-1',
} as const);

beforeEach(() => {
    getOrderMock.mockReset();
});

describe('createSaleSchema - compatibilidad de la unión discriminada', () => {
    const base = {
        paymentMethod: 'cash' as const,
        amountReceived: 100,
        cashSessionId: 'turno-1',
    };

    it('acepta un payload sin `kind` y lo trata como mercancía', () => {
        const parsed = createSaleSchema.parse({
            ...base,
            items: [{ productId: 'prod-1', quantity: 2, discountAmount: 5 }],
        });

        expect(parsed.items[0]).toMatchObject({
            kind: 'product',
            productId: 'prod-1',
            quantity: 2,
            discountAmount: 5,
        });
    });

    it('acepta una partida de servicio con doctor', () => {
        const parsed = createSaleSchema.parse({
            ...base,
            items: [{
                kind: 'service',
                serviceId: 'srv-1',
                quantity: 1,
                providerId: 'doc-1',
            }],
        });

        expect(parsed.items[0]).toMatchObject({
            kind: 'service',
            serviceId: 'srv-1',
            providerId: 'doc-1',
        });
    });

    it('acepta una venta mixta en el mismo payload', () => {
        const parsed = createSaleSchema.parse({
            ...base,
            items: [
                { productId: 'prod-1', quantity: 1 },
                { kind: 'service', serviceId: 'srv-1', quantity: 1, providerId: null },
            ],
        });

        expect(parsed.items.map((item) => item.kind)).toEqual(['product', 'service']);
    });

    it('rechaza una partida de servicio sin `serviceId`', () => {
        expect(() => createSaleSchema.parse({
            ...base,
            items: [{ kind: 'service', quantity: 1 }],
        })).toThrow();
    });

    it('rechaza una partida de mercancía sin `productId`', () => {
        expect(() => createSaleSchema.parse({
            ...base,
            items: [{ quantity: 1 }],
        })).toThrow();
    });
});

describe('createSale - venta 100 % producto (no regresión)', () => {
    it('descuenta lotes, mueve stock y no denormaliza servicios', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto({ salePrice: 100 });
        const lote = await surtir(producto.id, 5);
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [{ productId: producto.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        expect(venta.total).toBe(200);
        expect(venta.productIds).toEqual([producto.id]);
        expect(productItem(venta).batchAllocations).toEqual([
            { batchId: lote.id, quantity: 2 },
        ]);
        expect(serviceItems(venta)).toHaveLength(0);

        // La partición existe siempre, y en una venta de mercancía es 100 % farmacia.
        expect(venta.hasServices).toBe(false);
        expect(venta.serviceIds).toEqual([]);
        expect(venta.providerIds).toEqual([]);
        expect(venta.commissionTotal).toBe(0);
        expect(venta.pharmacyTotal).toBe(200);
        expect(venta.servicesTotal).toBe(0);
        expect(venta.pharmacyCashAmount).toBe(200);
        expect(venta.servicesCashAmount).toBe(0);

        const loteDespues = await batchesRepo.getBatchById(lote.id);
        expect(loteDespues!.quantity).toBe(3);
        const movimientos = await movementsRepo.listStockMovements({ productId: producto.id });
        expect(movimientos.filter((m) => m.referenceId === venta.id)).toHaveLength(1);
    });

    it('un payload sin `kind` produce exactamente la misma venta que con `kind`', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto({ salePrice: 50 });
        await surtir(producto.id, 4);
        const turno = await abrirTurno(cajero);

        const sinKind = await salesService.createSale({
            items: [{ productId: producto.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 50,
            cashSessionId: turno.id,
            cashierId: cajero,
        });
        const conKind = await salesService.createSale({
            items: [{ kind: 'product', productId: producto.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 50,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        expect(productItem(sinKind).kind).toBe('product');
        expect(sinKind.total).toBe(conKind.total);
        expect(sinKind.pharmacyTotal).toBe(conKind.pharmacyTotal);
        expect(productItem(sinKind).batchAllocations).toHaveLength(
            productItem(conKind).batchAllocations.length,
        );
    });
});

describe('createSale - venta 100 % servicio', () => {
    it('no toca lotes ni stock, y congela la comisión del doctor', async () => {
        const cajero = unique('cajero');
        const doctor = await crearDoctor();
        const servicio = await crearServicio({
            price: 250,
            commissionRate: 40,
            requiresPerformer: true,
            taxMode: 'exempt',
        });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [{
                kind: 'service',
                serviceId: servicio.id,
                quantity: 1,
                providerId: doctor.id,
            }],
            paymentMethod: 'cash',
            amountReceived: 250,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const partida = serviceItem(venta);
        expect(partida).toMatchObject({
            kind: 'service',
            serviceId: servicio.id,
            serviceName: servicio.name,
            providerId: doctor.id,
            providerName: doctor.name,
            quantity: 1,
            unitPrice: 250,
            commissionRate: 40,
            commissionAmount: 100,
        });
        // Una partida de servicio no lleva lotes: no hay de dónde descontar.
        expect(partida).not.toHaveProperty('batchAllocations');
        expect(productItems(venta)).toHaveLength(0);

        // Ni movimientos de inventario, ni ids de producto, ni libro de controlados.
        expect(venta.productIds).toEqual([]);
        const movimientos = await movementsRepo.listStockMovements({});
        expect(movimientos.filter((m) => m.referenceId === venta.id)).toHaveLength(0);
        const { items: libro } = await controlledService.listControlledLedger({
            saleId: venta.id,
        });
        expect(libro).toHaveLength(0);

        expect(venta.hasServices).toBe(true);
        expect(venta.serviceIds).toEqual([servicio.id]);
        expect(venta.providerIds).toEqual([doctor.id]);
        expect(venta.commissionTotal).toBe(100);
        expect(venta.commissionByProvider).toEqual({ [doctor.id]: 100 });
        expect(venta.pharmacyTotal).toBe(0);
        expect(venta.servicesTotal).toBe(250);
        expect(venta.servicesCashAmount).toBe(250);
        expect(venta.pharmacyCashAmount).toBe(0);
    });

    it('un servicio exento no declara IVA; uno con IVA 16 % sí', async () => {
        const cajero = unique('cajero');
        const exento = await crearServicio({ price: 250, taxMode: 'exempt', commissionRate: 0 });
        const gravado = await crearServicio({ price: 116, taxMode: 'iva16', commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [
                { kind: 'service', serviceId: exento.id, quantity: 1 },
                { kind: 'service', serviceId: gravado.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 366,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const [partidaExenta, partidaGravada] = serviceItems(venta);
        expect(partidaExenta.taxes).toMatchObject({ ivaRate: 0, ivaAmount: 0, base: 250 });
        expect(partidaGravada.taxes).toMatchObject({ ivaRate: 0.16, ivaAmount: 16, base: 100 });
        expect(venta.taxSummary?.ivaTotal).toBe(16);
    });

    it('un servicio con tasa 0 usa la comisión por omisión del doctor', async () => {
        const cajero = unique('cajero');
        const doctor = await crearDoctor({ defaultCommissionRate: 25 });
        const servicio = await crearServicio({
            price: 200,
            commissionRate: 0,
            requiresPerformer: true,
        });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [{
                kind: 'service',
                serviceId: servicio.id,
                quantity: 1,
                providerId: doctor.id,
            }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        expect(serviceItem(venta).commissionRate).toBe(25);
        expect(serviceItem(venta).commissionAmount).toBe(50);
        expect(venta.commissionTotal).toBe(50);
    });

    it('la comisión se calcula sobre el neto, no sobre el precio de lista', async () => {
        const cajero = unique('cajero');
        const doctor = await crearDoctor();
        const servicio = await crearServicio({ price: 200, commissionRate: 50 });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [{
                kind: 'service',
                serviceId: servicio.id,
                quantity: 1,
                discountAmount: 40,
                providerId: doctor.id,
            }],
            paymentMethod: 'cash',
            amountReceived: 160,
            cashSessionId: turno.id,
            cashierId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(venta.total).toBe(160);
        expect(serviceItem(venta).netAmount).toBe(160);
        expect(serviceItem(venta).commissionAmount).toBe(80);
    });
});

describe('createSale - validaciones de la rama de servicio', () => {
    const ventaDeServicio = async (
        serviceId: string,
        providerId?: string,
    ) => {
        const cajero = unique('cajero');
        const turno = await abrirTurno(cajero);
        return salesService.createSale({
            items: [{ kind: 'service', serviceId, quantity: 1, providerId }],
            paymentMethod: 'cash',
            amountReceived: 1000,
            cashSessionId: turno.id,
            cashierId: cajero,
        });
    };

    it('un servicio inexistente es NOT_FOUND', async () => {
        await expect(ventaDeServicio('servicio-que-no-existe')).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: expect.stringContaining('Servicio'),
        });
    });

    it('un servicio dado de baja es NOT_FOUND', async () => {
        const servicio = await crearServicio();
        await pharmacyServicesService.deletePharmacyService(servicio.id, ACTOR);

        await expect(ventaDeServicio(servicio.id)).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: expect.stringContaining('Servicio'),
        });
    });

    it('un servicio que exige quién lo realizó no se cobra sin doctor', async () => {
        const servicio = await crearServicio({ requiresPerformer: true });

        await expect(ventaDeServicio(servicio.id)).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('requiere indicar quién lo realizó'),
        });
    });

    it('un doctor dado de baja no puede recibir la comisión', async () => {
        const servicio = await crearServicio({ requiresPerformer: true });
        const doctor = await crearDoctor();
        await serviceProvidersService.deleteServiceProvider(doctor.id);

        await expect(ventaDeServicio(servicio.id, doctor.id)).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: expect.stringContaining('Doctor'),
        });
    });

    it('un doctor inexistente es NOT_FOUND', async () => {
        const servicio = await crearServicio();

        await expect(ventaDeServicio(servicio.id, 'doctor-fantasma')).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: expect.stringContaining('Doctor'),
        });
    });
});

describe('createSale - venta mixta y reparto "servicios primero"', () => {
    it('en efectivo puro el servicio se cubre primero y el resto es farmacia', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto({ salePrice: 100 });
        const lote = await surtir(producto.id, 3);
        const doctor = await crearDoctor();
        const servicio = await crearServicio({ price: 250, commissionRate: 40 });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 1 },
                { kind: 'service', serviceId: servicio.id, quantity: 1, providerId: doctor.id },
            ],
            paymentMethod: 'cash',
            amountReceived: 400,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        expect(venta.total).toBe(350);
        expect(venta.change).toBe(50);
        expect(venta.pharmacyTotal).toBe(100);
        expect(venta.servicesTotal).toBe(250);
        expect(venta.servicesCashAmount).toBe(250);
        expect(venta.pharmacyCashAmount).toBe(100);

        // Invariantes de la partición.
        expect(toCents(venta.pharmacyTotal!) + toCents(venta.servicesTotal!))
            .toBe(toCents(venta.total));
        expect(toCents(venta.pharmacyCashAmount!) + toCents(venta.servicesCashAmount!))
            .toBe(toCents(venta.cashAmount ?? 0));

        // Solo la mercancía movió inventario.
        expect(venta.productIds).toEqual([producto.id]);
        const loteDespues = await batchesRepo.getBatchById(lote.id);
        expect(loteDespues!.quantity).toBe(2);
        const movimientos = await movementsRepo.listStockMovements({ productId: producto.id });
        expect(movimientos.filter((m) => m.referenceId === venta.id)).toHaveLength(1);
    });

    it('en pago mixto el efectivo cubre el servicio antes que la mercancía', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto({ salePrice: 100 });
        await surtir(producto.id, 3);
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);
        const order = orderProcesada('200.00');
        getOrderMock.mockResolvedValue(order);

        const venta = await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 1 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'mixed',
            amountReceived: 150,
            cardPaymentReference: order.id,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        expect(venta.total).toBe(350);
        expect(venta.cardAmount).toBe(200);
        expect(venta.cashAmount).toBe(150);
        // El efectivo (150) no alcanza a cubrir los 250 de servicios: se va
        // completo a servicios y la farmacia queda en 0 de efectivo.
        expect(venta.servicesCashAmount).toBe(150);
        expect(venta.pharmacyCashAmount).toBe(0);
        expect(toCents(venta.pharmacyCashAmount!) + toCents(venta.servicesCashAmount!))
            .toBe(toCents(venta.cashAmount ?? 0));
        expect(toCents(venta.pharmacyTotal!) + toCents(venta.servicesTotal!))
            .toBe(toCents(venta.total));
    });

    it('con pago con tarjeta no hay efectivo que repartir', async () => {
        const cajero = unique('cajero');
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);
        const order = orderProcesada('250.00');
        getOrderMock.mockResolvedValue(order);

        const venta = await salesService.createSale({
            items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
            paymentMethod: 'card',
            cardPaymentReference: order.id,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        expect(venta.cashAmount).toBeNull();
        expect(venta.servicesCashAmount).toBe(0);
        expect(venta.pharmacyCashAmount).toBe(0);
        expect(venta.servicesTotal).toBe(250);
    });

    it('el descuento a nivel venta se reparte entre las dos ramas y siguen sumando el total',
        async () => {
            const cajero = unique('cajero');
            const producto = await crearProducto({ salePrice: 100 });
            await surtir(producto.id, 3);
            const servicio = await crearServicio({ price: 300, commissionRate: 10 });
            const turno = await abrirTurno(cajero);

            const venta = await salesService.createSale({
                items: [
                    { productId: producto.id, quantity: 1 },
                    { kind: 'service', serviceId: servicio.id, quantity: 1 },
                ],
                saleDiscountAmount: 40,
                paymentMethod: 'cash',
                amountReceived: 360,
                cashSessionId: turno.id,
                cashierId: cajero,
            });

            expect(venta.total).toBe(360);
            expect(toCents(venta.pharmacyTotal!) + toCents(venta.servicesTotal!))
                .toBe(toCents(venta.total));
            expect(toCents(venta.pharmacyCashAmount!) + toCents(venta.servicesCashAmount!))
                .toBe(toCents(venta.cashAmount ?? 0));
        });
});

describe('voidSale - venta mixta', () => {
    it('repone solo la mercancía y deja el servicio marcado por la anulación', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto({ salePrice: 100, controlledGroup: 'IV' });
        const lote = await surtir(producto.id, 5);
        const servicio = await crearServicio({ price: 250, commissionRate: 40 });
        const doctor = await crearDoctor();
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 2 },
                { kind: 'service', serviceId: servicio.id, quantity: 1, providerId: doctor.id },
            ],
            paymentMethod: 'cash',
            amountReceived: 450,
            cashSessionId: turno.id,
            cashierId: cajero,
            // El grupo IV exige receta: la venta mixta no relaja esa regla.
            prescription: { doctorName: 'Dra. Pérez', doctorLicense: '1234567' },
        });

        expect((await batchesRepo.getBatchById(lote.id))!.quantity).toBe(3);

        const anulada = await salesService.voidSale(venta.id, 'admin-user', 'admin');

        expect(anulada.voidedAt).toBeTruthy();
        // Lote y stock quedan como antes de la venta.
        expect((await batchesRepo.getBatchById(lote.id))!.quantity).toBe(5);
        expect((await productsRepo.getProductById(producto.id))!.totalStock).toBe(5);

        // Un movimiento de salida y uno de reversa, ambos de la mercancía.
        const movimientos = (await movementsRepo.listStockMovements({ productId: producto.id }))
            .filter((m) => m.referenceId === venta.id);
        expect(movimientos).toHaveLength(2);
        expect(movimientos.map((m) => m.quantity).sort((a, b) => a - b)).toEqual([-2, 2]);

        // El libro de controlados lleva el asiento y su contra-asiento; el
        // servicio no aparece en ninguno.
        const { items: libro } = await controlledService.listControlledLedger({
            saleId: venta.id,
        });
        expect(libro).toHaveLength(2);
        expect(libro.every((renglon) => renglon.productId === producto.id)).toBe(true);

        // La partida de servicio sigue ahí, sin rastro que revertir.
        expect(serviceItems(anulada)).toHaveLength(1);
        expect(serviceItem(anulada).commissionAmount).toBe(100);
    });

    it('anula una venta 100 % servicio sin tocar inventario', async () => {
        const cajero = unique('cajero');
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 250,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const anulada = await salesService.voidSale(venta.id, 'admin-user', 'admin');

        expect(anulada.voidedBy).toBe('admin-user');
        const movimientos = await movementsRepo.listStockMovements({});
        expect(movimientos.filter((m) => m.referenceId === venta.id)).toHaveLength(0);
    });
});

describe('sale-returns - los servicios no se devuelven', () => {
    it('rechaza la devolución de una partida de servicio', async () => {
        const cajero = 'admin-user';
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
            paymentMethod: 'cash',
            amountReceived: 250,
            cashSessionId: turno.id,
            cashierId: cajero,
            roleSlug: 'admin',
        });

        await expect(
            returnsService.createSaleReturn({
                saleId: venta.id,
                items: [{ productId: servicio.id, quantity: 1 }],
                reason: 'El paciente no quedó conforme',
                cashSessionId: turno.id,
                userId: cajero,
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: 'Los servicios no se devuelven; anula la venta completa',
        });
    });

    it('en una venta mixta la devolución del medicamento sigue funcionando', async () => {
        const cajero = 'admin-user';
        const producto = await crearProducto({ salePrice: 100 });
        const lote = await surtir(producto.id, 5);
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        const venta = await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 2 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 450,
            cashSessionId: turno.id,
            cashierId: cajero,
            roleSlug: 'admin',
        });

        const devolucion = await returnsService.createSaleReturn({
            saleId: venta.id,
            items: [{ productId: producto.id, quantity: 1 }],
            reason: 'Caja abierta',
            cashSessionId: turno.id,
            userId: cajero,
            roleSlug: 'admin',
        });

        expect(devolucion.refundTotal).toBe(100);
        expect(devolucion.items).toHaveLength(1);
        expect(devolucion.items[0].batchAllocations).toEqual([
            { batchId: lote.id, quantity: 1 },
        ]);
        expect((await batchesRepo.getBatchById(lote.id))!.quantity).toBe(4);
    });
});
