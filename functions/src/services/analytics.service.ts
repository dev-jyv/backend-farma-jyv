import {
    PaymentMethod,
    Sale,
    SaleReturn,
    SaleServiceItem,
    ServiceType,
    isSaleProductItem,
    isSaleServiceItem,
} from '../types';
import { fromCents, toCents } from '../utils/taxes';
import * as salesRepo from '../repositories/sales.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as movementsRepo from '../repositories/stock-movements.repository';
import * as pharmacyServicesRepo from '../repositories/pharmacy-services.repository';

/**
 * Reportes de gestión. Todo se calcula sobre ventas **no anuladas** y se descuenta
 * lo devuelto: un reporte que ignora devoluciones sobreestima la venta del día.
 *
 * El margen se calcula sobre la **base sin impuestos** (`taxSummary.base`), no sobre
 * el total cobrado: el IVA no es ingreso de la farmacia. Ventas sin costo capturado
 * (`costTotal === null`) se reportan aparte en `withoutCost` en lugar de contarse
 * como utilidad del 100%.
 */

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    mixed: 'Mixto',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface PeriodFilters {
    from?: string;
    to?: string;
}

const loadPeriod = async (
    filters: PeriodFilters,
): Promise<{ sales: Sale[]; returns: SaleReturn[] }> => {
    const [{ items: sales }, returns] = await Promise.all([
        salesRepo.listSales({ from: filters.from, to: filters.to }),
        returnsRepo.listSaleReturns({ from: filters.from, to: filters.to }),
    ]);
    return { sales, returns };
};

/**
 * Una de las dos ramas del negocio dentro del mismo periodo. `share` es la
 * participación sobre el total bruto, en porcentaje.
 */
export interface SalesSummaryBranch {
    /** Ventas con importe en esta rama; una venta mixta cuenta en las dos. */
    salesCount: number;
    total: number;
    share: number;
}

export interface SalesSummaryServicesBranch extends SalesSummaryBranch {
    commissionTotal: number;
}

export interface SalesSummaryReport {
    salesCount: number;
    grossTotal: number;
    discountTotal: number;
    refundTotal: number;
    netTotal: number;
    taxBase: number;
    ivaTotal: number;
    iepsTotal: number;
    ticketAverage: number;
    byPaymentMethod: Array<{
        method: PaymentMethod;
        label: string;
        count: number;
        total: number;
    }>;
    byDay: Array<{ date: string; salesCount: number; total: number }>;
    /**
     * Desglose farmacia / servicios del mismo periodo. Sale de los campos
     * denormalizados de cada venta (`pharmacyTotal` / `servicesTotal`), **sin
     * recorrer partidas**: es justo para lo que se denormalizaron.
     */
    pharmacy: SalesSummaryBranch;
    services: SalesSummaryServicesBranch;
}

/** Participación de una rama sobre el bruto del periodo, en porcentaje. */
const share = (branchCents: number, grossCents: number): number =>
    grossCents <= 0 ? 0 : Math.round((branchCents / grossCents) * 10000) / 100;

export const getSalesSummary = async (
    filters: PeriodFilters,
): Promise<SalesSummaryReport> => {
    const { sales, returns } = await loadPeriod(filters);

    const byMethod = new Map<PaymentMethod, { count: number; cents: number }>();
    const byDay = new Map<string, { salesCount: number; cents: number }>();

    let grossCents = 0;
    let discountCents = 0;
    let baseCents = 0;
    let ivaCents = 0;
    let iepsCents = 0;

    let pharmacyCents = 0;
    let pharmacySalesCount = 0;
    let servicesCents = 0;
    let servicesSalesCount = 0;
    let commissionCents = 0;

    for (const sale of sales) {
        grossCents += toCents(sale.total);

        // Defaults de compatibilidad: `pharmacyTotal ?? total` y
        // `servicesTotal ?? 0` dejan toda venta histórica como 100 % farmacia.
        const saleServicesCents = toCents(sale.servicesTotal ?? 0);
        const salePharmacyCents = toCents(sale.pharmacyTotal ?? sale.total);
        servicesCents += saleServicesCents;
        pharmacyCents += salePharmacyCents;
        commissionCents += toCents(sale.commissionTotal ?? 0);
        if (saleServicesCents > 0) {
            servicesSalesCount += 1;
        }
        if (salePharmacyCents > 0) {
            pharmacySalesCount += 1;
        }

        discountCents += toCents(sale.discountTotal);
        baseCents += toCents(sale.taxSummary?.base ?? 0);
        ivaCents += toCents(sale.taxSummary?.ivaTotal ?? 0);
        iepsCents += toCents(sale.taxSummary?.iepsTotal ?? 0);

        const method = byMethod.get(sale.paymentMethod) ?? { count: 0, cents: 0 };
        method.count += 1;
        method.cents += toCents(sale.total);
        byMethod.set(sale.paymentMethod, method);

        const date = sale.createdAt.toDate().toISOString().slice(0, 10);
        const day = byDay.get(date) ?? { salesCount: 0, cents: 0 };
        day.salesCount += 1;
        day.cents += toCents(sale.total);
        byDay.set(date, day);
    }

    const refundCents = returns.reduce(
        (total, saleReturn) => total + toCents(saleReturn.refundTotal),
        0,
    );

    return {
        salesCount: sales.length,
        grossTotal: fromCents(grossCents),
        discountTotal: fromCents(discountCents),
        refundTotal: fromCents(refundCents),
        netTotal: fromCents(grossCents - refundCents),
        taxBase: fromCents(baseCents),
        ivaTotal: fromCents(ivaCents),
        iepsTotal: fromCents(iepsCents),
        ticketAverage: sales.length ? fromCents(Math.round(grossCents / sales.length)) : 0,
        byPaymentMethod: [...byMethod.entries()]
            .map(([method, totals]) => ({
                method,
                label: PAYMENT_LABELS[method],
                count: totals.count,
                total: fromCents(totals.cents),
            }))
            .sort((a, b) => b.total - a.total),
        byDay: [...byDay.entries()]
            .map(([date, totals]) => ({
                date,
                salesCount: totals.salesCount,
                total: fromCents(totals.cents),
            }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        pharmacy: {
            salesCount: pharmacySalesCount,
            total: fromCents(pharmacyCents),
            share: share(pharmacyCents, grossCents),
        },
        services: {
            salesCount: servicesSalesCount,
            total: fromCents(servicesCents),
            share: share(servicesCents, grossCents),
            commissionTotal: fromCents(commissionCents),
        },
    };
};

export interface ProfitReport {
    revenueBase: number;
    cost: number;
    profit: number;
    /** Margen sobre la base sin impuestos, en porcentaje. */
    marginRate: number;
    salesWithCost: number;
    /** Ventas sin costo capturado; su utilidad no se puede calcular. */
    salesWithoutCost: number;
    byProduct: Array<{
        productId: string;
        productName: string;
        quantity: number;
        revenueBase: number;
        cost: number;
        profit: number;
        marginRate: number;
    }>;
}

const marginRate = (baseCents: number, costCents: number): number => {
    if (baseCents <= 0) {
        return 0;
    }
    return Math.round(((baseCents - costCents) / baseCents) * 10000) / 100;
};

export const getProfitReport = async (
    filters: PeriodFilters & { limit?: number },
): Promise<ProfitReport> => {
    const { sales, returns } = await loadPeriod(filters);

    // Unidades devueltas por producto, para no acreditar utilidad de lo que regresó.
    const returnedByProduct = new Map<string, number>();
    for (const saleReturn of returns) {
        for (const item of saleReturn.items) {
            returnedByProduct.set(
                item.productId,
                (returnedByProduct.get(item.productId) ?? 0) + item.quantity,
            );
        }
    }

    const byProduct = new Map<string, {
        productName: string;
        quantity: number;
        baseCents: number;
        costCents: number;
    }>();

    let revenueCents = 0;
    let costCents = 0;
    let salesWithCost = 0;
    let salesWithoutCost = 0;

    for (const sale of sales) {
        const hasCost = sale.costTotal !== null && sale.costTotal !== undefined;
        if (hasCost) {
            salesWithCost += 1;
        } else {
            salesWithoutCost += 1;
        }

        // Margen de **mercancía**: un servicio no tiene costo de venta y
        // aparecería con 100 % de utilidad. Su corte se lleva aparte.
        for (const item of sale.items.filter(isSaleProductItem)) {
            const itemBaseCents = toCents(item.taxes?.base ?? 0);
            const itemCostCents = item.costAmount === null || item.costAmount === undefined
                ? null
                : toCents(item.costAmount);

            const entry = byProduct.get(item.productId) ?? {
                productName: item.productName,
                quantity: 0,
                baseCents: 0,
                costCents: 0,
            };
            entry.quantity += item.quantity;
            entry.baseCents += itemBaseCents;
            entry.costCents += itemCostCents ?? 0;
            byProduct.set(item.productId, entry);

            revenueCents += itemBaseCents;
            costCents += itemCostCents ?? 0;
        }
    }

    // Las devoluciones se restan a nivel reporte (proporcional al importe devuelto).
    const refundBaseCents = returns.reduce(
        (total, saleReturn) => total + toCents(saleReturn.taxSummary.base),
        0,
    );
    revenueCents -= refundBaseCents;

    const limit = filters.limit ?? 20;

    return {
        revenueBase: fromCents(revenueCents),
        cost: fromCents(costCents),
        profit: fromCents(revenueCents - costCents),
        marginRate: marginRate(revenueCents, costCents),
        salesWithCost,
        salesWithoutCost,
        byProduct: [...byProduct.entries()]
            .map(([productId, entry]) => ({
                productId,
                productName: entry.productName,
                quantity: entry.quantity - (returnedByProduct.get(productId) ?? 0),
                revenueBase: fromCents(entry.baseCents),
                cost: fromCents(entry.costCents),
                profit: fromCents(entry.baseCents - entry.costCents),
                marginRate: marginRate(entry.baseCents, entry.costCents),
            }))
            .sort((a, b) => b.profit - a.profit)
            .slice(0, limit),
    };
};

export interface TopProductsReport {
    items: Array<{
        productId: string;
        productName: string;
        quantity: number;
        total: number;
        salesCount: number;
    }>;
}

export const getTopProducts = async (
    filters: PeriodFilters & { limit?: number },
): Promise<TopProductsReport> => {
    const { sales, returns } = await loadPeriod(filters);

    const returnedByProduct = new Map<string, { quantity: number; cents: number }>();
    for (const saleReturn of returns) {
        for (const item of saleReturn.items) {
            const entry = returnedByProduct.get(item.productId) ?? { quantity: 0, cents: 0 };
            entry.quantity += item.quantity;
            entry.cents += toCents(item.refundAmount);
            returnedByProduct.set(item.productId, entry);
        }
    }

    const byProduct = new Map<string, {
        productName: string;
        quantity: number;
        cents: number;
        salesCount: number;
    }>();

    for (const sale of sales) {
        for (const item of sale.items.filter(isSaleProductItem)) {
            const entry = byProduct.get(item.productId) ?? {
                productName: item.productName,
                quantity: 0,
                cents: 0,
                salesCount: 0,
            };
            entry.quantity += item.quantity;
            entry.cents += toCents(item.netAmount ?? item.subtotal - item.discountAmount);
            entry.salesCount += 1;
            byProduct.set(item.productId, entry);
        }
    }

    return {
        items: [...byProduct.entries()]
            .map(([productId, entry]) => {
                const returned = returnedByProduct.get(productId);
                return {
                    productId,
                    productName: entry.productName,
                    quantity: entry.quantity - (returned?.quantity ?? 0),
                    total: fromCents(entry.cents - (returned?.cents ?? 0)),
                    salesCount: entry.salesCount,
                };
            })
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, filters.limit ?? 20),
    };
};

export interface CashierReport {
    items: Array<{
        cashierId: string;
        salesCount: number;
        total: number;
        ticketAverage: number;
        discountTotal: number;
        voidedCount: number;
        refundTotal: number;
    }>;
}

export const getSalesByCashier = async (
    filters: PeriodFilters,
): Promise<CashierReport> => {
    const [{ items: sales }, returns] = await Promise.all([
        // Se incluyen anuladas para poder contarlas por cajero (señal de control).
        salesRepo.listSales({ from: filters.from, to: filters.to, includeVoided: true }),
        returnsRepo.listSaleReturns({ from: filters.from, to: filters.to }),
    ]);

    const refundByUser = new Map<string, number>();
    for (const saleReturn of returns) {
        refundByUser.set(
            saleReturn.createdBy,
            (refundByUser.get(saleReturn.createdBy) ?? 0) + toCents(saleReturn.refundTotal),
        );
    }

    const byCashier = new Map<string, {
        salesCount: number;
        cents: number;
        discountCents: number;
        voidedCount: number;
    }>();

    for (const sale of sales) {
        const entry = byCashier.get(sale.cashierId) ?? {
            salesCount: 0,
            cents: 0,
            discountCents: 0,
            voidedCount: 0,
        };
        if (sale.voidedAt) {
            entry.voidedCount += 1;
        } else {
            entry.salesCount += 1;
            entry.cents += toCents(sale.total);
            entry.discountCents += toCents(sale.discountTotal);
        }
        byCashier.set(sale.cashierId, entry);
    }

    return {
        items: [...byCashier.entries()]
            .map(([cashierId, entry]) => ({
                cashierId,
                salesCount: entry.salesCount,
                total: fromCents(entry.cents),
                ticketAverage: entry.salesCount
                    ? fromCents(Math.round(entry.cents / entry.salesCount))
                    : 0,
                discountTotal: fromCents(entry.discountCents),
                voidedCount: entry.voidedCount,
                refundTotal: fromCents(refundByUser.get(cashierId) ?? 0),
            }))
            .sort((a, b) => b.total - a.total),
    };
};

export interface DeadStockReport {
    /** Días sin salida considerados para declarar el producto sin movimiento. */
    days: number;
    items: Array<{
        productId: string;
        productName: string;
        sku: string;
        totalStock: number;
        lastMovementAt: string | null;
        daysWithoutMovement: number | null;
    }>;
}

/**
 * Productos con existencia y sin salida en N días. Solo cuentan las salidas
 * (`sale_adjustment`, mermas, caducados): una entrada reciente no significa que el
 * producto se venda.
 */
export const getDeadStock = async (options: {
    days?: number;
    limit?: number;
} = {}): Promise<DeadStockReport> => {
    const days = options.days ?? 90;
    const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();

    const [products, batches, movements] = await Promise.all([
        productsRepo.listProducts({ activeOnly: true }),
        batchesRepo.listBatchesWithStock(),
        movementsRepo.listStockMovements({ from: since }),
    ]);

    const OUTBOUND = new Set(['sale_adjustment', 'exit_waste', 'exit_expiry']);
    const lastOutboundByProduct = new Map<string, number>();
    for (const movement of movements) {
        if (!OUTBOUND.has(movement.type)) {
            continue;
        }
        const millis = movement.createdAt.toMillis();
        const current = lastOutboundByProduct.get(movement.productId) ?? 0;
        if (millis > current) {
            lastOutboundByProduct.set(movement.productId, millis);
        }
    }

    const stockByProduct = new Map<string, number>();
    for (const batch of batches) {
        stockByProduct.set(
            batch.productId,
            (stockByProduct.get(batch.productId) ?? 0) + batch.quantity,
        );
    }

    const items = products
        .filter((product) => {
            const stock = product.totalStock ?? stockByProduct.get(product.id) ?? 0;
            return stock > 0 && !lastOutboundByProduct.has(product.id);
        })
        .map((product) => ({
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            totalStock: product.totalStock ?? stockByProduct.get(product.id) ?? 0,
            lastMovementAt: null,
            daysWithoutMovement: null,
        }))
        .sort((a, b) => b.totalStock - a.totalStock)
        .slice(0, options.limit ?? 50);

    return { days, items };
};

/* -------------------------------------------------------------------------- */
/*  Servicios de farmacia                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Importe neto de una partida de servicio: lo efectivamente cobrado por ella.
 * `netAmount` falta en las ventas anteriores a que existiera, y ahí se
 * reconstruye igual que en la rama de mercancía.
 */
const serviceNetCents = (item: SaleServiceItem): number =>
    toCents(item.netAmount ?? item.subtotal - item.discountAmount);

/**
 * Solo las ventas del periodo. A diferencia de `loadPeriod`, no lee
 * devoluciones: **un servicio no se devuelve** —`createSaleReturn` rechaza la
 * partida de servicio— así que no hay nada que restar. Lo anulado tampoco entra:
 * `listSales` descarta las ventas con `voidedAt` salvo que se pida lo contrario.
 */
const loadPeriodSales = async (filters: PeriodFilters): Promise<Sale[]> => {
    const { items } = await salesRepo.listSales({ from: filters.from, to: filters.to });
    return items;
};

export interface TopServicesReport {
    items: Array<{
        serviceId: string;
        serviceName: string;
        quantity: number;
        total: number;
        salesCount: number;
    }>;
}

/**
 * Servicios más cobrados del periodo, espejo de `getTopProducts`: agrupa por
 * `serviceId` sumando cantidad e importe neto y ordena por cantidad.
 */
export const getTopServices = async (
    filters: PeriodFilters & { limit?: number },
): Promise<TopServicesReport> => {
    const sales = await loadPeriodSales(filters);

    const byService = new Map<string, {
        serviceName: string;
        quantity: number;
        cents: number;
        salesCount: number;
    }>();

    for (const sale of sales) {
        for (const item of sale.items.filter(isSaleServiceItem)) {
            const entry = byService.get(item.serviceId) ?? {
                serviceName: item.serviceName,
                quantity: 0,
                cents: 0,
                salesCount: 0,
            };
            entry.quantity += item.quantity;
            entry.cents += serviceNetCents(item);
            entry.salesCount += 1;
            byService.set(item.serviceId, entry);
        }
    }

    return {
        items: [...byService.entries()]
            .map(([serviceId, entry]) => ({
                serviceId,
                serviceName: entry.serviceName,
                quantity: entry.quantity,
                total: fromCents(entry.cents),
                salesCount: entry.salesCount,
            }))
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, filters.limit ?? 20),
    };
};

export interface CommissionsReport {
    items: Array<{
        /** `null` en el renglón de los servicios cobrados sin doctor. */
        providerId: string | null;
        providerName: string | null;
        /** Procedimientos cobrados: suma de la cantidad de las partidas. */
        servicesCount: number;
        /**
         * Base de la comisión: el importe **neto cobrado** por esos servicios
         * (no `taxSummary.base`; la comisión se calcula sobre lo cobrado).
         */
        base: number;
        commissionTotal: number;
    }>;
    /** Totales generales del periodo, incluido el renglón sin doctor. */
    servicesCount: number;
    base: number;
    commissionTotal: number;
}

/** Clave interna del renglón de servicios sin doctor asignado. */
const NO_PROVIDER = '__sin_doctor__';

/**
 * Comisiones por doctor del periodo.
 *
 * Con `providerId` usa la consulta indexada
 * (`providerIds array-contains` + rango de `createdAt`); sin él recorre el
 * periodo completo como los demás reportes. En los dos casos las anuladas se
 * descartan en memoria, igual que el corte.
 *
 * **Servicios sin doctor**: se agrupan en un renglón aparte con
 * `providerId: null` en vez de descartarse. Un servicio puede tener
 * `commissionRate > 0` sin exigir quién lo realizó (`requiresPerformer: false`),
 * así que su comisión existe y descartarla haría que el total del reporte no
 * cuadre con el `commissionTotal` de las ventas.
 */
export const getCommissionsByProvider = async (
    filters: PeriodFilters & { providerId?: string },
): Promise<CommissionsReport> => {
    const sales = filters.providerId
        ? await salesRepo.listSalesByProvider({
            providerId: filters.providerId,
            from: filters.from,
            to: filters.to,
        })
        : await loadPeriodSales(filters);

    const byProvider = new Map<string, {
        providerId: string | null;
        providerName: string | null;
        servicesCount: number;
        baseCents: number;
        commissionCents: number;
    }>();

    for (const sale of sales) {
        for (const item of sale.items.filter(isSaleServiceItem)) {
            // Con filtro por doctor, la venta puede traer partidas de otros
            // doctores: solo cuenta lo del doctor pedido.
            if (filters.providerId && item.providerId !== filters.providerId) {
                continue;
            }
            const key = item.providerId ?? NO_PROVIDER;
            const entry = byProvider.get(key) ?? {
                providerId: item.providerId ?? null,
                providerName: item.providerName ?? null,
                servicesCount: 0,
                baseCents: 0,
                commissionCents: 0,
            };
            entry.servicesCount += item.quantity;
            entry.baseCents += serviceNetCents(item);
            entry.commissionCents += toCents(item.commissionAmount);
            byProvider.set(key, entry);
        }
    }

    const items = [...byProvider.values()]
        .map((entry) => ({
            providerId: entry.providerId,
            providerName: entry.providerName,
            servicesCount: entry.servicesCount,
            base: fromCents(entry.baseCents),
            commissionTotal: fromCents(entry.commissionCents),
        }))
        .sort((a, b) => b.commissionTotal - a.commissionTotal);

    const totals = [...byProvider.values()].reduce(
        (acc, entry) => ({
            servicesCount: acc.servicesCount + entry.servicesCount,
            baseCents: acc.baseCents + entry.baseCents,
            commissionCents: acc.commissionCents + entry.commissionCents,
        }),
        { servicesCount: 0, baseCents: 0, commissionCents: 0 },
    );

    return {
        items,
        servicesCount: totals.servicesCount,
        base: fromCents(totals.baseCents),
        commissionTotal: fromCents(totals.commissionCents),
    };
};

export interface ServicesSummaryReport {
    /** Ventas del periodo que cobraron al menos un servicio. */
    salesCount: number;
    /** Servicios cobrados: suma de la cantidad de las partidas de servicio. */
    servicesCount: number;
    total: number;
    commissionTotal: number;
    /** Efectivo que entró al cajón por servicios (regla "servicios primero"). */
    cashTotal: number;
    byType: Array<{
        serviceType: ServiceType;
        servicesCount: number;
        total: number;
        commissionTotal: number;
    }>;
}

/** Los tres renglones salen siempre, en este orden, aunque vengan en cero. */
const SERVICE_TYPES: ServiceType[] = ['consultation', 'procedure', 'other'];

/**
 * Corte de la rama de servicios del periodo. Los totales salen de los campos
 * denormalizados de la venta; el desglose por `serviceType` sí necesita las
 * partidas, porque la naturaleza del servicio vive en el catálogo y no se
 * congela en la partida: se resuelve contra `pharmacyServices` (un servicio
 * borrado del catálogo cae en `other`).
 */
export const getServicesSummary = async (
    filters: PeriodFilters,
): Promise<ServicesSummaryReport> => {
    const [sales, catalog] = await Promise.all([
        loadPeriodSales(filters),
        pharmacyServicesRepo.listPharmacyServices(),
    ]);

    const typeByServiceId = new Map<string, ServiceType>(
        catalog.map((service) => [service.id, service.serviceType]),
    );

    const byType = new Map<ServiceType, {
        servicesCount: number;
        cents: number;
        commissionCents: number;
    }>(SERVICE_TYPES.map((type) => [type, {
        servicesCount: 0,
        cents: 0,
        commissionCents: 0,
    }]));

    let salesCount = 0;
    let servicesCount = 0;
    let totalCents = 0;
    let commissionCents = 0;
    let cashCents = 0;

    for (const sale of sales) {
        const saleServicesCents = toCents(sale.servicesTotal ?? 0);
        if (!sale.hasServices && saleServicesCents === 0) {
            continue;
        }
        salesCount += 1;
        totalCents += saleServicesCents;
        commissionCents += toCents(sale.commissionTotal ?? 0);
        cashCents += toCents(sale.servicesCashAmount ?? 0);

        for (const item of sale.items.filter(isSaleServiceItem)) {
            servicesCount += item.quantity;
            const entry = byType.get(typeByServiceId.get(item.serviceId) ?? 'other')!;
            entry.servicesCount += item.quantity;
            entry.cents += serviceNetCents(item);
            entry.commissionCents += toCents(item.commissionAmount);
        }
    }

    return {
        salesCount,
        servicesCount,
        total: fromCents(totalCents),
        commissionTotal: fromCents(commissionCents),
        cashTotal: fromCents(cashCents),
        byType: SERVICE_TYPES.map((serviceType) => {
            const entry = byType.get(serviceType)!;
            return {
                serviceType,
                servicesCount: entry.servicesCount,
                total: fromCents(entry.cents),
                commissionTotal: fromCents(entry.commissionCents),
            };
        }),
    };
};
