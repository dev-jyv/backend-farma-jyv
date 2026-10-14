import * as servicesRepo from '../repositories/pharmacy-services.repository';
import * as salesRepo from '../repositories/sales.repository';
import { PharmacyService, Sale, isSaleServiceItem } from '../types';
import { notFound } from '../utils/errors';
import { fromDate } from '../utils/firestore';
import { MemoryCache } from '../utils/memory-cache';
import { fromCents, toCents } from '../utils/taxes';
import {
    Granularity,
    SeriesOptions,
    SeriesPoint,
    SeriesRow,
    buildSeries,
    clampPeriods,
    seriesStartMs,
} from './analytics-series';
import {
    DEFAULT_ANALYTICS_MONTHS,
    addMonths,
    monthOf,
    monthRange,
    monthStartMs,
} from './product-analytics.service';

/**
 * Análisis de UN servicio del consultorio, espejo del de producto: ventas por
 * mes y año, precio cobrado, comisiones y reparto por doctor. Una sola consulta
 * de ventas (`serviceIds array-contains` + `createdAt`) alimenta todo.
 *
 * Un servicio no tiene costo de venta ni se devuelve (`createSaleReturn` lo
 * rechaza), así que no hay margen sobre costo ni devoluciones que restar: el
 * "neto" aquí es el ingreso menos la comisión del doctor.
 */

const CACHE_TTL_MS = 60 * 1000;

interface TimestampLike {
    toMillis(): number;
}

export interface ServiceAnalyticsInput {
    service: Pick<PharmacyService,
        'id' | 'code' | 'name' | 'price' | 'commissionRate' | 'requiresPerformer' | 'isActive'>
        & { serviceType?: string };
    now: Date;
    months: number;
    /** Si viene, la respuesta agrega `series` por día o semana. */
    series?: SeriesOptions;
    sales: Array<Pick<Sale, 'items' | 'voidedAt'> & { createdAt: TimestampLike }>;
}

export interface ServiceTotals {
    units: number;
    /** Cobrado con impuestos. */
    revenue: number;
    commission: number;
    /** Ingreso menos comisión del doctor. */
    net: number;
}

export interface ServiceMonthlyPoint extends ServiceTotals {
    month: string;
    avgPrice: number | null;
    minPrice: number | null;
    maxPrice: number | null;
}

export interface ServiceProviderLine {
    /** `null` = cobrado sin doctor. */
    providerId: string | null;
    providerName: string | null;
    units: number;
    revenue: number;
    commission: number;
}

export interface ServiceAnalytics {
    service: {
        id: string;
        code: string;
        name: string;
        serviceType: string | null;
        requiresPerformer: boolean;
        isActive: boolean;
    };
    generatedAt: string;
    months: number;
    kpis: {
        currentPrice: number;
        /** Porcentaje vigente en el catálogo (las ventas guardan el de su momento). */
        commissionRate: number;
        salesMonth: ServiceTotals;
        salesYear: ServiceTotals;
    };
    monthly: ServiceMonthlyPoint[];
    /** Solo con `granularity` día o semana: ventas por cubeta, la más reciente al final. */
    granularity?: Exclude<Granularity, 'month'>;
    series?: SeriesPoint[];
    /** Reparto por doctor en toda la ventana. */
    byProvider: ServiceProviderLine[];
}

interface Acc {
    units: number;
    netCents: number;
    commissionCents: number;
    priceWeightCents: number;
    min: number | null;
    max: number | null;
}

const emptyAcc = (): Acc => ({
    units: 0,
    netCents: 0,
    commissionCents: 0,
    priceWeightCents: 0,
    min: null,
    max: null,
});

const totalsOf = (accs: Acc[]): ServiceTotals => {
    const units = accs.reduce((total, acc) => total + acc.units, 0);
    const netCents = accs.reduce((total, acc) => total + acc.netCents, 0);
    const commissionCents = accs.reduce((total, acc) => total + acc.commissionCents, 0);
    return {
        units,
        revenue: fromCents(netCents),
        commission: fromCents(commissionCents),
        net: fromCents(netCents - commissionCents),
    };
};

export const buildServiceAnalytics = (input: ServiceAnalyticsInput): ServiceAnalytics => {
    const { service, now, months } = input;
    const currentMonth = monthOf(now.getTime());
    const currentYearStart = `${currentMonth.slice(0, 4)}-01`;
    const windowStart = addMonths(currentMonth, -(months - 1));
    const firstMonth = windowStart < currentYearStart ? windowStart : currentYearStart;
    const allMonths = monthRange(firstMonth, currentMonth);
    const accs = new Map(allMonths.map((month) => [month, emptyAcc()]));
    const providers = new Map<string, { name: string | null; acc: Acc }>();
    const windowMonths = new Set(monthRange(windowStart, currentMonth));
    const seriesRows: SeriesRow[] = [];

    for (const sale of input.sales) {
        if (sale.voidedAt) {
            continue;
        }
        const month = monthOf(sale.createdAt.toMillis());
        const acc = accs.get(month);
        for (const item of sale.items.filter(isSaleServiceItem)) {
            if (item.serviceId !== service.id) {
                continue;
            }
            const netCents = toCents(item.netAmount ?? item.subtotal - item.discountAmount);
            const commissionCents = toCents(item.commissionAmount ?? 0);
            if (input.series) {
                seriesRows.push({
                    ms: sale.createdAt.toMillis(),
                    units: item.quantity,
                    netCents,
                    commissionCents,
                    unitPrice: item.unitPrice,
                });
            }
            if (!acc) {
                continue;
            }
            acc.units += item.quantity;
            acc.netCents += netCents;
            acc.commissionCents += commissionCents;
            acc.priceWeightCents += toCents(item.unitPrice) * item.quantity;
            acc.min = acc.min === null ? item.unitPrice : Math.min(acc.min, item.unitPrice);
            acc.max = acc.max === null ? item.unitPrice : Math.max(acc.max, item.unitPrice);

            if (windowMonths.has(month)) {
                const key = item.providerId ?? '';
                const provider = providers.get(key) ?? { name: item.providerName, acc: emptyAcc() };
                provider.acc.units += item.quantity;
                provider.acc.netCents += netCents;
                provider.acc.commissionCents += commissionCents;
                providers.set(key, provider);
            }
        }
    }

    const monthly: ServiceMonthlyPoint[] = monthRange(windowStart, currentMonth).map((month) => {
        const acc = accs.get(month)!;
        return {
            month,
            ...totalsOf([acc]),
            avgPrice: acc.units > 0
                ? fromCents(Math.round(acc.priceWeightCents / acc.units))
                : null,
            minPrice: acc.min,
            maxPrice: acc.max,
        };
    });

    return {
        service: {
            id: service.id,
            code: service.code,
            name: service.name,
            serviceType: service.serviceType ?? null,
            requiresPerformer: service.requiresPerformer,
            isActive: service.isActive,
        },
        generatedAt: now.toISOString(),
        months,
        kpis: {
            currentPrice: service.price,
            commissionRate: service.commissionRate,
            salesMonth: totalsOf([accs.get(currentMonth)!]),
            salesYear: totalsOf(
                allMonths.filter((month) => month >= currentYearStart).map((m) => accs.get(m)!),
            ),
        },
        monthly,
        ...(input.series
            ? {
                granularity: input.series.granularity,
                series: buildSeries(seriesRows, now.getTime(), input.series),
            }
            : {}),
        byProvider: [...providers.entries()]
            .map(([key, provider]) => ({
                providerId: key || null,
                providerName: provider.name,
                units: provider.acc.units,
                revenue: fromCents(provider.acc.netCents),
                commission: fromCents(provider.acc.commissionCents),
            }))
            .sort((a, b) => b.revenue - a.revenue),
    };
};

// ---------------------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------------------

const cache = new MemoryCache<ServiceAnalytics>(CACHE_TTL_MS, 100);

/**
 * Lecturas: 1 servicio + las ventas que lo cobraron en la ventana (una consulta
 * indexada). Cache de 60 s por instancia.
 */
export const getServiceAnalytics = async (
    serviceId: string,
    months: number = DEFAULT_ANALYTICS_MONTHS,
    options: { granularity?: Granularity; periods?: number } = {},
): Promise<ServiceAnalytics> => {
    const series: SeriesOptions | undefined = options.granularity && options.granularity !== 'month'
        ? {
            granularity: options.granularity,
            periods: clampPeriods(options.granularity, options.periods),
        }
        : undefined;
    const key = `${serviceId}:${months}:${series ? `${series.granularity}${series.periods}` : 'm'}`;
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }

    const service = await servicesRepo.getPharmacyServiceById(serviceId);
    if (!service) {
        throw notFound('Servicio');
    }

    const now = new Date();
    const currentMonth = monthOf(now.getTime());
    const windowStart = addMonths(currentMonth, -(months - 1));
    const yearStart = `${currentMonth.slice(0, 4)}-01`;
    const monthsSinceMs = monthStartMs(windowStart < yearStart ? windowStart : yearStart);
    const since = new Date(series
        ? Math.min(monthsSinceMs, seriesStartMs(now.getTime(), series))
        : monthsSinceMs);

    const sales = await salesRepo.listSalesByServiceBetween(
        serviceId,
        fromDate(since),
        fromDate(new Date(now.getTime() + 1)),
    );

    const result = buildServiceAnalytics({ service, now, months, series, sales });
    cache.set(key, result);
    return result;
};

// ---------------------------------------------------------------------------
// Búsqueda por nombre (para el asistente de IA)
// ---------------------------------------------------------------------------

export interface ServiceMatch {
    id: string;
    code: string;
    name: string;
    price: number;
    isActive: boolean;
}

const normalizeText = (value: string): string =>
    value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

/** El catálogo de servicios es chico: se guarda 5 minutos y se filtra en memoria. */
const catalogCache = new MemoryCache<ServiceMatch[]>(5 * 60 * 1000, 1);

export const findServicesByName = async (query: string, limit = 5): Promise<ServiceMatch[]> => {
    const term = normalizeText(query);
    if (!term) {
        return [];
    }
    let catalog = catalogCache.get('all');
    if (!catalog) {
        const services = await servicesRepo.listPharmacyServices();
        catalog = services.map((service) => ({
            id: service.id,
            code: service.code,
            name: service.name,
            price: service.price,
            isActive: service.isActive,
        }));
        catalogCache.set('all', catalog);
    }
    return catalog
        .filter((service) =>
            normalizeText(service.name).includes(term) ||
            normalizeText(service.code).includes(term))
        .slice(0, Math.min(Math.max(limit, 1), 10));
};
