import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as pharmacyServicesService from '../src/services/pharmacy-services.service';
import * as serviceProvidersService from '../src/services/service-providers.service';
import * as salesService from '../src/services/sales.service';
import * as analyticsService from '../src/services/analytics.service';
import { db, now, toTimestamp } from '../src/utils/firestore';
import { toCents } from '../src/utils/taxes';

/**
 * Estadísticas de los servicios de farmacia (fase 4).
 *
 * El emulador es **compartido y serial**: otras suites dejan ventas dentro de la
 * misma ventana de tiempo que estos reportes leen. Por eso casi todo se mide por
 * **delta** (reporte antes / reporte después de la venta bajo prueba) en vez de
 * comparar cifras absolutas: es la única forma de afirmar algo exacto sobre un
 * agregado global sin depender de lo que hicieron las demás suites.
 *
 * Lo que se fija aquí:
 *
 * 1. El desglose por rama sale de los campos denormalizados, y una venta
 *    histórica **sin** esos campos se comporta como 100 % farmacia.
 * 2. Top de servicios y comisiones agrupan bien y no cuentan lo anulado.
 * 3. Los servicios **no** contaminan los reportes de mercancía
 *    (`getTopProducts`, `getProfitReport`): es la regresión más cara.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const ACTOR = { userId: 'test-admin' };

/** Ventana amplia para que los reportes no dependan del reloj del emulador. */
const period = () => ({
    from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

const crearProducto = async (salePrice = 116) => {
    const category = await categoriesRepo.createCategory({
        name: unique('Categoria'),
        isActive: true,
    });
    return productsRepo.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice,
        minStock: 0,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        requiresPrescription: false,
        suppliers: [],
    });
};

const surtir = async (productId: string, quantity: number, costPrice = 50) => {
    const batch = await batchesRepo.createBatch({
        productId,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-06-01'),
        quantity,
        costPrice,
    });
    await productsRepo.updateProduct(productId, { totalStock: quantity });
    return batch;
};

const crearServicio = (overrides: Record<string, unknown> = {}) =>
    pharmacyServicesService.createPharmacyService({
        code: unique('SRV'),
        name: unique('Servicio'),
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

describe('getSalesSummary - desglose farmacia / servicios', () => {
    it('una venta 100 % producto deja servicios en cero y todo el importe en farmacia',
        async () => {
            const cajero = unique('cajero');
            const producto = await crearProducto(116);
            await surtir(producto.id, 5);
            const turno = await abrirTurno(cajero);

            const antes = await analyticsService.getSalesSummary(period());

            const venta = await salesService.createSale({
                items: [{ productId: producto.id, quantity: 2 }],
                paymentMethod: 'cash',
                amountReceived: 232,
                cashSessionId: turno.id,
                cashierId: cajero,
            });

            const despues = await analyticsService.getSalesSummary(period());

            expect(venta.total).toBe(232);
            // Todo el delta se fue a farmacia; servicios y comisiones no se movieron.
            expect(toCents(despues.pharmacy.total) - toCents(antes.pharmacy.total))
                .toBe(toCents(232));
            expect(despues.pharmacy.salesCount).toBe(antes.pharmacy.salesCount + 1);
            expect(toCents(despues.services.total)).toBe(toCents(antes.services.total));
            expect(despues.services.salesCount).toBe(antes.services.salesCount);
            expect(toCents(despues.services.commissionTotal))
                .toBe(toCents(antes.services.commissionTotal));
        });

    it('las dos ramas siempre suman el bruto del periodo', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto(100);
        await surtir(producto.id, 3);
        const servicio = await crearServicio({ price: 250, commissionRate: 40 });
        const doctor = await crearDoctor();
        const turno = await abrirTurno(cajero);

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 1 },
                { kind: 'service', serviceId: servicio.id, quantity: 1, providerId: doctor.id },
            ],
            paymentMethod: 'cash',
            amountReceived: 350,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const summary = await analyticsService.getSalesSummary(period());

        expect(toCents(summary.pharmacy.total) + toCents(summary.services.total))
            .toBe(toCents(summary.grossTotal));
        expect(summary.services.total).toBeGreaterThanOrEqual(250);
        expect(summary.services.commissionTotal).toBeGreaterThanOrEqual(100);
        // Una venta mixta cuenta en las dos ramas.
        expect(summary.services.salesCount).toBeGreaterThanOrEqual(1);
        expect(summary.pharmacy.salesCount).toBeGreaterThanOrEqual(1);
        expect(summary.pharmacy.share + summary.services.share).toBeCloseTo(100, 1);
    });

    it('una venta histórica sin los campos denormalizados es 100 % farmacia', async () => {
        const producto = await crearProducto(100);

        const antes = await analyticsService.getSalesSummary(period());
        const serviciosAntes = await analyticsService.getServicesSummary(period());

        // Documento tal como lo escribía el backend **antes** de los servicios:
        // sin `kind` en la partida y sin ninguno de los denormalizados.
        await db().collection('sales').add({
            folio: unique('LEGACY'),
            productIds: [producto.id],
            items: [{
                productId: producto.id,
                productName: producto.name,
                quantity: 1,
                unitPrice: 100,
                discountAmount: 0,
                subtotal: 100,
                netAmount: 100,
                batchAllocations: [],
            }],
            subtotal: 100,
            discountTotal: 0,
            total: 100,
            paymentMethod: 'cash',
            amountReceived: 100,
            change: 0,
            cardPaymentReference: null,
            pointPayment: null,
            cashSessionId: null,
            cashierId: unique('cajero'),
            customerId: null,
            customerName: null,
            prescription: null,
            billing: null,
            invoiceStatus: null,
            voidedAt: null,
            voidedBy: null,
            createdAt: now(),
        });

        const despues = await analyticsService.getSalesSummary(period());

        expect(toCents(despues.pharmacy.total) - toCents(antes.pharmacy.total))
            .toBe(toCents(100));
        expect(toCents(despues.services.total)).toBe(toCents(antes.services.total));
        expect(despues.services.salesCount).toBe(antes.services.salesCount);
        expect(toCents(despues.pharmacy.total) + toCents(despues.services.total))
            .toBe(toCents(despues.grossTotal));

        // Y tampoco aparece en el corte de servicios.
        const servicios = await analyticsService.getServicesSummary(period());
        expect(servicios.salesCount).toBe(serviciosAntes.salesCount);
        expect(servicios.servicesCount).toBe(serviciosAntes.servicesCount);
        expect(toCents(servicios.total)).toBe(toCents(serviciosAntes.total));
        // Los tres renglones del desglose salen siempre y en orden fijo.
        expect(servicios.byType.map((row) => row.serviceType))
            .toEqual(['consultation', 'procedure', 'other']);
    });
});

describe('getTopServices', () => {
    it('agrupa por servicio y ordena por cantidad', async () => {
        const cajero = unique('cajero');
        const fuerte = await crearServicio({ price: 100, commissionRate: 0 });
        const flojo = await crearServicio({ price: 100, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        await salesService.createSale({
            items: [
                { kind: 'service', serviceId: fuerte.id, quantity: 3 },
                { kind: 'service', serviceId: flojo.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 400,
            cashSessionId: turno.id,
            cashierId: cajero,
        });
        // El mismo servicio en otra venta se acumula en el mismo renglón.
        await salesService.createSale({
            items: [{ kind: 'service', serviceId: fuerte.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const top = await analyticsService.getTopServices({ ...period(), limit: 200 });
        const filaFuerte = top.items.find((item) => item.serviceId === fuerte.id)!;
        const filaFlojo = top.items.find((item) => item.serviceId === flojo.id)!;

        expect(filaFuerte).toMatchObject({
            serviceName: fuerte.name,
            quantity: 5,
            total: 500,
            salesCount: 2,
        });
        expect(filaFlojo.quantity).toBe(1);
        expect(top.items.indexOf(filaFuerte)).toBeLessThan(top.items.indexOf(filaFlojo));
    });

    it('una venta anulada no cuenta', async () => {
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
        await salesService.voidSale(venta.id, 'admin-user', 'admin');

        const top = await analyticsService.getTopServices({ ...period(), limit: 200 });

        expect(top.items.find((item) => item.serviceId === servicio.id)).toBeUndefined();
    });

    it('no mezcla mercancía en el top de servicios', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto(100);
        await surtir(producto.id, 5);
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 2 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 450,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const top = await analyticsService.getTopServices({ ...period(), limit: 200 });

        expect(top.items.find((item) => item.serviceId === servicio.id)!.quantity).toBe(1);
        expect(top.items.some((item) => item.serviceId === producto.id)).toBe(false);
    });
});

describe('getCommissionsByProvider', () => {
    it('agrupa por doctor y suma el mismo doctor en dos ventas', async () => {
        const cajero = unique('cajero');
        const doctor = await crearDoctor();
        const servicio = await crearServicio({
            price: 200,
            commissionRate: 50,
            requiresPerformer: true,
        });
        const turno = await abrirTurno(cajero);

        for (let venta = 0; venta < 2; venta += 1) {
            await salesService.createSale({
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
        }

        const reporte = await analyticsService.getCommissionsByProvider(period());
        const fila = reporte.items.find((item) => item.providerId === doctor.id)!;

        expect(fila).toMatchObject({
            providerName: doctor.name,
            servicesCount: 2,
            base: 400,
            commissionTotal: 200,
        });
        // Y ordena por comisión descendente.
        const comisiones = reporte.items.map((item) => item.commissionTotal);
        expect([...comisiones].sort((a, b) => b - a)).toEqual(comisiones);
        // El total general incluye a este doctor.
        expect(reporte.commissionTotal).toBeGreaterThanOrEqual(200);
    });

    it('un servicio sin doctor no revienta el reporte: cae en el renglón sin doctor',
        async () => {
            const cajero = unique('cajero');
            // Comisión > 0 y sin exigir quién lo realizó: el caso que obliga a
            // decidir qué hacer con la comisión huérfana.
            const servicio = await crearServicio({
                price: 300,
                commissionRate: 10,
                requiresPerformer: false,
            });
            const turno = await abrirTurno(cajero);

            const antes = await analyticsService.getCommissionsByProvider(period());
            const antesSinDoctor = antes.items.find((item) => item.providerId === null);

            await salesService.createSale({
                items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 300,
                cashSessionId: turno.id,
                cashierId: cajero,
            });

            const despues = await analyticsService.getCommissionsByProvider(period());
            const sinDoctor = despues.items.find((item) => item.providerId === null)!;

            expect(sinDoctor.providerName).toBeNull();
            expect(toCents(sinDoctor.base) - toCents(antesSinDoctor?.base ?? 0))
                .toBe(toCents(300));
            expect(
                toCents(sinDoctor.commissionTotal) -
                    toCents(antesSinDoctor?.commissionTotal ?? 0),
            ).toBe(toCents(30));
            // Ningún renglón queda con doctor "undefined": o hay id, o es null.
            expect(despues.items.every((item) => item.providerId !== undefined)).toBe(true);
        });

    it('filtrar por doctor devuelve solo lo de ese doctor', async () => {
        const cajero = unique('cajero');
        const mio = await crearDoctor();
        const ajeno = await crearDoctor();
        const servicio = await crearServicio({
            price: 100,
            commissionRate: 20,
            requiresPerformer: true,
        });
        const turno = await abrirTurno(cajero);

        // Los dos doctores en la **misma** venta: el filtro tiene que quedarse
        // solo con las partidas del doctor pedido, no con la venta completa.
        await salesService.createSale({
            items: [
                { kind: 'service', serviceId: servicio.id, quantity: 1, providerId: mio.id },
                { kind: 'service', serviceId: servicio.id, quantity: 2, providerId: ajeno.id },
            ],
            paymentMethod: 'cash',
            amountReceived: 300,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const reporte = await analyticsService.getCommissionsByProvider({
            ...period(),
            providerId: mio.id,
        });

        expect(reporte.items).toHaveLength(1);
        expect(reporte.items[0]).toMatchObject({
            providerId: mio.id,
            providerName: mio.name,
            servicesCount: 1,
            base: 100,
            commissionTotal: 20,
        });
        expect(reporte.commissionTotal).toBe(20);
        expect(reporte.base).toBe(100);
        expect(reporte.servicesCount).toBe(1);
    });

    it('una venta anulada no genera comisión', async () => {
        const cajero = unique('cajero');
        const doctor = await crearDoctor();
        const servicio = await crearServicio({
            price: 500,
            commissionRate: 30,
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
            amountReceived: 500,
            cashSessionId: turno.id,
            cashierId: cajero,
        });
        await salesService.voidSale(venta.id, 'admin-user', 'admin');

        const filtrado = await analyticsService.getCommissionsByProvider({
            ...period(),
            providerId: doctor.id,
        });
        const completo = await analyticsService.getCommissionsByProvider(period());

        expect(filtrado.items).toHaveLength(0);
        expect(filtrado.commissionTotal).toBe(0);
        expect(completo.items.some((item) => item.providerId === doctor.id)).toBe(false);
    });
});

describe('getServicesSummary', () => {
    it('cuenta servicios, total, comisión y efectivo, y desglosa por naturaleza',
        async () => {
            const cajero = unique('cajero');
            const doctor = await crearDoctor();
            const consulta = await crearServicio({
                serviceType: 'consultation',
                price: 250,
                commissionRate: 40,
                requiresPerformer: true,
            });
            const procedimiento = await crearServicio({
                serviceType: 'procedure',
                price: 300,
                commissionRate: 0,
            });
            const turno = await abrirTurno(cajero);

            const antes = await analyticsService.getServicesSummary(period());
            const antesPorTipo = (tipo: string) =>
                antes.byType.find((row) => row.serviceType === tipo)!;

            await salesService.createSale({
                items: [
                    {
                        kind: 'service',
                        serviceId: consulta.id,
                        quantity: 1,
                        providerId: doctor.id,
                    },
                    { kind: 'service', serviceId: procedimiento.id, quantity: 2 },
                ],
                paymentMethod: 'cash',
                amountReceived: 850,
                cashSessionId: turno.id,
                cashierId: cajero,
            });

            const despues = await analyticsService.getServicesSummary(period());
            const despuesPorTipo = (tipo: string) =>
                despues.byType.find((row) => row.serviceType === tipo)!;

            expect(despues.salesCount).toBe(antes.salesCount + 1);
            expect(despues.servicesCount).toBe(antes.servicesCount + 3);
            expect(toCents(despues.total) - toCents(antes.total)).toBe(toCents(850));
            expect(toCents(despues.commissionTotal) - toCents(antes.commissionTotal))
                .toBe(toCents(100));
            // Efectivo puro: los 850 del servicio entraron al cajón.
            expect(toCents(despues.cashTotal) - toCents(antes.cashTotal)).toBe(toCents(850));

            expect(
                despuesPorTipo('consultation').servicesCount -
                    antesPorTipo('consultation').servicesCount,
            ).toBe(1);
            expect(
                toCents(despuesPorTipo('consultation').total) -
                    toCents(antesPorTipo('consultation').total),
            ).toBe(toCents(250));
            expect(
                despuesPorTipo('procedure').servicesCount -
                    antesPorTipo('procedure').servicesCount,
            ).toBe(2);
            expect(
                toCents(despuesPorTipo('procedure').total) -
                    toCents(antesPorTipo('procedure').total),
            ).toBe(toCents(600));

            // El desglose por tipo suma el total de la rama.
            const sumaTipos = despues.byType.reduce(
                (total, row) => total + toCents(row.total),
                0,
            );
            expect(sumaTipos).toBe(toCents(despues.total));
        });

    it('una venta 100 % producto no entra al corte de servicios', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto(100);
        await surtir(producto.id, 4);
        const turno = await abrirTurno(cajero);

        const antes = await analyticsService.getServicesSummary(period());

        await salesService.createSale({
            items: [{ productId: producto.id, quantity: 2 }],
            paymentMethod: 'cash',
            amountReceived: 200,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const despues = await analyticsService.getServicesSummary(period());

        expect(despues).toMatchObject({
            salesCount: antes.salesCount,
            servicesCount: antes.servicesCount,
            total: antes.total,
            commissionTotal: antes.commissionTotal,
            cashTotal: antes.cashTotal,
        });
    });
});

describe('reportes de mercancía - los servicios no los contaminan', () => {
    it('un servicio no aparece en getTopProducts', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto(100);
        await surtir(producto.id, 6);
        const servicio = await crearServicio({ price: 250, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 3 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 550,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const top = await analyticsService.getTopProducts({ ...period(), limit: 200 });

        expect(top.items.find((item) => item.productId === producto.id)!.quantity).toBe(3);
        // Ni con el id del servicio ni con el nombre del servicio.
        expect(top.items.some((item) => item.productId === servicio.id)).toBe(false);
        expect(top.items.some((item) => item.productName === servicio.name)).toBe(false);
    });

    it('un servicio no infla getProfitReport: sin costo daría 100 % de utilidad',
        async () => {
            const cajero = unique('cajero');
            const servicio = await crearServicio({ price: 1000, commissionRate: 0 });
            const turno = await abrirTurno(cajero);

            const antes = await analyticsService.getProfitReport({ ...period(), limit: 200 });

            await salesService.createSale({
                items: [{ kind: 'service', serviceId: servicio.id, quantity: 1 }],
                paymentMethod: 'cash',
                amountReceived: 1000,
                cashSessionId: turno.id,
                cashierId: cajero,
            });

            const despues = await analyticsService.getProfitReport({
                ...period(),
                limit: 200,
            });

            // Mil pesos de servicio no movieron ni el ingreso ni la utilidad de
            // mercancía, y no dejaron renglón en el reporte por producto.
            expect(toCents(despues.revenueBase)).toBe(toCents(antes.revenueBase));
            expect(toCents(despues.profit)).toBe(toCents(antes.profit));
            expect(despues.byProduct.some((row) => row.productId === servicio.id))
                .toBe(false);
            expect(despues.byProduct.some((row) => row.productName === servicio.name))
                .toBe(false);
        });

    it('en una venta mixta el margen sale solo de la mercancía', async () => {
        const cajero = unique('cajero');
        const producto = await crearProducto(116);
        await surtir(producto.id, 5, 60);
        const servicio = await crearServicio({ price: 500, commissionRate: 0 });
        const turno = await abrirTurno(cajero);

        await salesService.createSale({
            items: [
                { productId: producto.id, quantity: 1 },
                { kind: 'service', serviceId: servicio.id, quantity: 1 },
            ],
            paymentMethod: 'cash',
            amountReceived: 616,
            cashSessionId: turno.id,
            cashierId: cajero,
        });

        const profit = await analyticsService.getProfitReport({ ...period(), limit: 200 });
        const fila = profit.byProduct.find((row) => row.productId === producto.id)!;

        // Base 100 (el IVA no es ingreso), costo 60 → utilidad 40, margen 40 %.
        expect(fila).toMatchObject({ revenueBase: 100, cost: 60, profit: 40, marginRate: 40 });
    });
});
