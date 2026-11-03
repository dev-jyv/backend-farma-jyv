import * as promotionsRepo from '../../../repositories/promotions.repository';
import * as salesRepo from '../../../repositories/sales.repository';
import { fromCents, toCents } from '../../../utils/taxes';
import { Promotion } from '../../../types';
import { getSalesByCashier, getTopProducts } from '../../analytics.service';
import { getSalesByHour } from '../../insights.service';
import { NO_CASHIER, resolveUserNames } from '../../module-reports.service';
import { computePromotionPerformance } from '../../promotion-performance.service';
import { ReportDefinition, ReportRow } from '../report-definition';
import { resolveReportPeriod } from '../period';
import { MAX_ROWS } from './shared';

export const topProductos: ReportDefinition = {
    key: 'top-productos',
    title: 'Productos más vendidos',
    columns: [
        { key: 'product', header: 'Producto', type: 'text' },
        { key: 'quantity', header: 'Unidades', type: 'int', total: true },
        { key: 'sales', header: 'Ventas', type: 'int' },
        { key: 'total', header: 'Importe', type: 'money', total: true },
        { key: 'abc', header: 'Clase ABC', type: 'text' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getTopProducts({ from: range.from, to: range.to, limit: MAX_ROWS });
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: report.items.map((item) => ({
                product: item.productName,
                quantity: item.quantity,
                sales: item.salesCount,
                total: item.total,
                abc: item.abcClass ?? 'Sin costo',
            })),
            emptyMessage: 'Sin ventas en el periodo.',
            notes: ['La clase ABC se calcula por utilidad; "Sin costo" es un producto sin costo '
                + 'capturado, cuya utilidad no se puede clasificar.'],
        };
    },
};

export const porCajero: ReportDefinition = {
    key: 'por-cajero',
    title: 'Ventas por cajero',
    columns: [
        { key: 'cashier', header: 'Cajero', type: 'text' },
        { key: 'sales', header: 'Ventas', type: 'int', total: true },
        { key: 'total', header: 'Total', type: 'money', total: true },
        { key: 'ticket', header: 'Ticket promedio', type: 'money' },
        { key: 'discount', header: 'Descuentos', type: 'money', total: true },
        { key: 'voided', header: 'Canceladas', type: 'int', total: true },
        { key: 'refunds', header: 'Devuelto', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getSalesByCashier({ from: range.from, to: range.to });
        const names = await resolveUserNames(report.items.map((item) => item.cashierId));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: report.items.map((item) => ({
                cashier: names.get(item.cashierId) ?? NO_CASHIER,
                sales: item.salesCount,
                total: item.total,
                ticket: item.ticketAverage,
                discount: item.discountTotal,
                voided: item.voidedCount,
                refunds: item.refundTotal,
            })),
            emptyMessage: 'Sin ventas en el periodo.',
        };
    },
};

export const ventasPorHora: ReportDefinition = {
    key: 'ventas-por-hora',
    title: 'Ventas por hora',
    columns: [
        { key: 'hour', header: 'Hora', type: 'text' },
        { key: 'sales', header: 'Ventas', type: 'int', total: true },
        { key: 'total', header: 'Total', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getSalesByHour({ from: range.from, to: range.to });
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: report.byHour
                .filter((bucket) => bucket.salesCount > 0)
                .map((bucket) => ({
                    hour: `${String(bucket.hour).padStart(2, '0')}:00`,
                    sales: bucket.salesCount,
                    total: bucket.total,
                })),
            emptyMessage: 'Sin ventas en el periodo.',
            notes: ['Hora local de la farmacia.'],
        };
    },
};

/** Lunes primero: es como se lee una semana de trabajo; en los datos 0 = domingo. */
const WEEKDAY_ORDER: Array<{ weekday: number; label: string }> = [
    { weekday: 1, label: 'Lunes' },
    { weekday: 2, label: 'Martes' },
    { weekday: 3, label: 'Miércoles' },
    { weekday: 4, label: 'Jueves' },
    { weekday: 5, label: 'Viernes' },
    { weekday: 6, label: 'Sábado' },
    { weekday: 0, label: 'Domingo' },
];

export const ventasPorDiaSemana: ReportDefinition = {
    key: 'ventas-por-dia-semana',
    title: 'Ventas por día de la semana',
    columns: [
        { key: 'day', header: 'Día', type: 'text' },
        { key: 'sales', header: 'Ventas', type: 'int', total: true },
        { key: 'total', header: 'Total', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getSalesByHour({ from: range.from, to: range.to });
        const byWeekday = new Map(report.byWeekday.map((bucket) => [bucket.weekday, bucket]));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: WEEKDAY_ORDER.map(({ weekday, label }) => ({
                day: label,
                sales: byWeekday.get(weekday)?.salesCount ?? 0,
                total: byWeekday.get(weekday)?.total ?? 0,
            })),
            notes: ['Suma todos los días del periodo que caen en ese día de la semana.'],
        };
    },
};

const MAX_PROMOTIONS = 100;
const PROMOTION_BATCH = 5;
const dayFormat = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
});

/** Fin de vigencia: lo primero entre `endsAt` y `deactivatedAt`; `Infinity` si sigue abierta. */
const effectiveEndMs = (promotion: Promotion): number => {
    const ends = [promotion.endsAt, promotion.deactivatedAt]
        .filter((stamp): stamp is NonNullable<typeof stamp> => stamp !== null)
        .map((stamp) => stamp.toMillis());
    return ends.length ? Math.min(...ends) : Infinity;
};

export const promociones: ReportDefinition = {
    key: 'promociones',
    title: 'Desempeño de promociones',
    columns: [
        { key: 'name', header: 'Promoción', type: 'text' },
        { key: 'start', header: 'Inicio', type: 'text' },
        { key: 'end', header: 'Fin', type: 'text' },
        { key: 'sales', header: 'Ventas', type: 'int', total: true },
        { key: 'units', header: 'Unidades', type: 'int', total: true },
        { key: 'discount', header: 'Descuento otorgado', type: 'money', total: true },
        { key: 'revenue', header: 'Ingreso neto', type: 'money', total: true },
        { key: 'profit', header: 'Utilidad', type: 'money', total: true },
        { key: 'lift', header: 'Cambio en ventas', type: 'percent' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const fromMs = Date.parse(range.from);
        const toMs = Date.parse(range.to);
        const promotions = (await promotionsRepo.listPromotions())
            .filter((promotion) =>
                promotion.startsAt.toMillis() <= toMs && effectiveEndMs(promotion) >= fromMs)
            .sort((a, b) => b.startsAt.toMillis() - a.startsAt.toMillis())
            .slice(0, MAX_PROMOTIONS);

        // Cada promoción son dos consultas; en lotes para no abrir cien a la vez.
        const rows: ReportRow[] = [];
        for (let index = 0; index < promotions.length; index += PROMOTION_BATCH) {
            const batch = promotions.slice(index, index + PROMOTION_BATCH);
            const performances = await Promise.all(
                batch.map((promotion) => computePromotionPerformance(promotion, now.getTime())),
            );
            performances.forEach((performance, position) => {
                const promotion = batch[position];
                rows.push({
                    name: performance.name,
                    start: dayFormat.format(new Date(performance.startsAt)),
                    end: promotion.isActive && !promotion.endsAt
                        ? 'Vigente'
                        : dayFormat.format(new Date(performance.effectiveEnd)),
                    sales: performance.salesCount,
                    units: performance.unitsSold,
                    discount: performance.discountTotal,
                    revenue: performance.netRevenue,
                    profit: performance.grossProfit,
                    lift: performance.liftPercent,
                });
            });
        }
        return {
            subtitle: `Promociones vigentes en ${range.label}`,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin promociones vigentes en el periodo.',
            notes: [
                'Cada promoción se mide durante toda su vigencia, no solo en el periodo elegido.',
                'Utilidad vacía: alguna partida no tiene costo capturado. Cambio en ventas vacío: '
                + 'antes de la promoción no se vendía nada con qué comparar.',
                ...(promotions.length === MAX_PROMOTIONS
                    ? [`Se muestran las ${MAX_PROMOTIONS} promociones más recientes.`]
                    : []),
            ],
        };
    },
};

/**
 * Cupones usados en el periodo (SPEC 47): usos y descuento por cupón. Sale de
 * `Sale.coupon` de las ventas no anuladas del periodo, leídas una vez; no hace
 * falta índice extra porque ya se recorre el periodo completo.
 */
export const cupones: ReportDefinition = {
    key: 'cupones',
    title: 'Cupones usados',
    columns: [
        { key: 'code', header: 'Código', type: 'text' },
        { key: 'name', header: 'Cupón', type: 'text' },
        { key: 'scope', header: 'Alcance', type: 'text' },
        { key: 'uses', header: 'Usos', type: 'int', total: true },
        { key: 'discount', header: 'Descuento otorgado', type: 'money', total: true },
        { key: 'revenue', header: 'Venta con cupón', type: 'money', total: true },
        { key: 'review', header: 'Por revisar', type: 'int', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const { items: sales } = await salesRepo.listSales({ from: range.from, to: range.to });
        const byCoupon = new Map<string, {
            code: string; name: string; scope: string;
            uses: number; discountCents: number; revenueCents: number; review: number;
        }>();
        for (const sale of sales) {
            if (sale.voidedAt || !sale.coupon) {
                continue;
            }
            const entry = byCoupon.get(sale.coupon.couponId) ?? {
                code: sale.coupon.code,
                name: sale.coupon.name,
                scope: sale.coupon.scope === 'product' ? 'Producto' : 'Venta',
                uses: 0,
                discountCents: 0,
                revenueCents: 0,
                review: 0,
            };
            entry.uses += 1;
            entry.discountCents += toCents(sale.coupon.discountAmount);
            entry.revenueCents += toCents(sale.total);
            entry.review += sale.couponReview ? 1 : 0;
            byCoupon.set(sale.coupon.couponId, entry);
        }
        const rows: ReportRow[] = [...byCoupon.values()]
            .sort((a, b) => b.discountCents - a.discountCents || a.code.localeCompare(b.code))
            .map((entry) => ({
                code: entry.code,
                name: entry.name,
                scope: entry.scope,
                uses: entry.uses,
                discount: fromCents(entry.discountCents),
                revenue: fromCents(entry.revenueCents),
                review: entry.review,
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin ventas con cupón en el periodo.',
            notes: [
                'Las ventas anuladas no cuentan; anular o devolver no devuelve el uso del cupón.',
                'Por revisar: ventas offline aceptadas con el cupón vencido o agotado.',
            ],
        };
    },
};

export const salesDefinitions: ReportDefinition[] = [
    topProductos,
    porCajero,
    ventasPorHora,
    ventasPorDiaSemana,
    promociones,
    cupones,
];
