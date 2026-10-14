import * as returnsRepo from '../../../repositories/sale-returns.repository';
import * as cashSessionsRepo from '../../../repositories/cash-sessions.repository';
import * as salesRepo from '../../../repositories/sales.repository';
import { RefundMethod } from '../../../types';
import { formatCurrency } from '../../../utils/currency';
import { fromCents, toCents } from '../../../utils/taxes';
import { getZonedYmd } from '../../../utils/timezone';
import { listExpenses } from '../../accounting.service';
import { getProfitReport, getSalesSummary } from '../../analytics.service';
import {
    NO_CASHIER,
    ReportScope,
    buildExpenseRows,
    buildSalesRows,
    resolveUserNames,
} from '../../module-reports.service';
import { PAYMENT_METHOD_LABELS, REPORTS_TIME_ZONE } from '../../sales-reports.service';
import { ReportDefinition } from '../report-definition';
import { resolveReportPeriod } from '../period';
import { MAX_ROWS, percentOf, stampDate, stampTime, ymdToDisplay } from './shared';

const SCOPE_LABELS: Record<ReportScope, string> = {
    pharmacy: 'Farmacia',
    clinic: 'Consultorio',
    financial: 'Financiero',
};

const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
};

export const ventas: ReportDefinition = {
    key: 'ventas',
    title: 'Ventas',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'time', header: 'Hora', type: 'text' },
        { key: 'folio', header: 'Folio', type: 'text' },
        { key: 'cashier', header: 'Cobró', type: 'text' },
        { key: 'payment', header: 'Pago', type: 'text' },
        { key: 'concept', header: 'Concepto', type: 'text' },
        { key: 'amount', header: 'Importe', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const scope = query.scope ?? 'financial';
        const { items: sales } = await salesRepo.listSales({ from: range.from, to: range.to });
        const names = await resolveUserNames(sales.map((sale) => sale.cashierId));
        return {
            subtitle: `${SCOPE_LABELS[scope]} · ${range.label}`,
            slug: `${scope}-${range.slug}`,
            rows: buildSalesRows(sales, scope, names).map((row) => ({ ...row })),
            emptyMessage: 'Sin ventas registradas en el periodo.',
            notes: ['Las ventas anuladas no se incluyen. Una venta mixta aparece en farmacia y '
                + 'en consultorio con el importe de su parte.'],
        };
    },
};

export const utilidad: ReportDefinition = {
    key: 'utilidad',
    title: 'Utilidad y margen',
    columns: [
        { key: 'product', header: 'Producto', type: 'text' },
        { key: 'quantity', header: 'Unidades', type: 'int', total: true },
        { key: 'revenue', header: 'Venta sin impuestos', type: 'money', total: true },
        { key: 'cost', header: 'Costo', type: 'money', total: true },
        { key: 'profit', header: 'Utilidad', type: 'money', total: true },
        { key: 'margin', header: 'Margen', type: 'percent' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getProfitReport({ from: range.from, to: range.to, limit: MAX_ROWS });
        const notes = [
            `Periodo: venta sin impuestos ${formatCurrency(report.revenueBase)}, costo `
            + `${formatCurrency(report.cost)}, utilidad ${formatCurrency(report.profit)} `
            + `(margen ${report.marginRate.toFixed(2)}%).`,
            'El margen se calcula sobre la venta sin IVA ni IEPS y descuenta lo devuelto.',
        ];
        if (report.salesWithoutCost > 0) {
            notes.push(
                `${report.salesWithoutCost} ventas sin costo capturado no entran a la utilidad.`,
            );
        }
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: report.byProduct.map((item) => ({
                product: item.productName,
                quantity: item.quantity,
                revenue: item.revenueBase,
                cost: item.cost,
                profit: item.profit,
                margin: item.marginRate,
            })),
            notes,
        };
    },
};

export const corteCaja: ReportDefinition = {
    key: 'corte-caja',
    title: 'Corte de caja por turno',
    columns: [
        { key: 'opened', header: 'Apertura', type: 'text' },
        { key: 'closed', header: 'Cierre', type: 'text' },
        { key: 'cashier', header: 'Cajero', type: 'text' },
        { key: 'opening', header: 'Fondo inicial', type: 'money', total: true },
        { key: 'sales', header: 'Ventas', type: 'int', total: true },
        { key: 'grandTotal', header: 'Total vendido', type: 'money', total: true },
        { key: 'expected', header: 'Efectivo esperado', type: 'money', total: true },
        { key: 'counted', header: 'Efectivo contado', type: 'money', total: true },
        { key: 'difference', header: 'Diferencia', type: 'money', total: true },
        { key: 'status', header: 'Estado', type: 'text' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const { items } = await cashSessionsRepo.listCashSessions({
            from: range.from,
            to: range.to,
            page: 1,
            limit: MAX_ROWS,
        });
        const names = await resolveUserNames(items.map((session) => session.openedBy));
        const rows = [...items]
            .sort((a, b) => a.openedAt.toMillis() - b.openedAt.toMillis())
            .map((session) => ({
                opened: `${stampDate(session.openedAt)} ${stampTime(session.openedAt)}`,
                closed: session.closedAt
                    ? `${stampDate(session.closedAt)} ${stampTime(session.closedAt)}`
                    : 'Abierto',
                cashier: names.get(session.openedBy) ?? NO_CASHIER,
                opening: session.openingAmount,
                sales: session.summary?.salesCount ?? null,
                grandTotal: session.summary?.grandTotal ?? null,
                // El cajón es uno: el conteo se compara contra farmacia + servicios.
                expected: session.expectedCashAmount === null
                    ? null
                    : fromCents(toCents(session.expectedCashAmount)
                        + toCents(session.expectedServicesCashAmount ?? 0)),
                counted: session.countedCashAmount,
                difference: session.cashDifference,
                status: !session.closedAt
                    ? 'Abierto'
                    : session.autoClosedByExpiry
                        ? 'Cierre automático'
                        : session.hasPendingAdjustment ? 'Con diferencia' : 'Cuadrado',
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin turnos de caja en el periodo.',
            notes: ['Un turno abierto no tiene efectivo contado ni diferencia todavía.'],
        };
    },
};

const loadExpenses = async (range: { from: string; to: string }) => {
    const { items } = await listExpenses({
        from: range.from,
        to: range.to,
        page: 1,
        limit: MAX_ROWS,
        maxLimit: MAX_ROWS,
    });
    const names = await resolveUserNames(items.map((movement) => movement.createdBy));
    return buildExpenseRows(items, names);
};

export const gastos: ReportDefinition = {
    key: 'gastos',
    title: 'Gastos',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'time', header: 'Hora', type: 'text' },
        { key: 'category', header: 'Categoría', type: 'text' },
        { key: 'concept', header: 'Concepto', type: 'text' },
        { key: 'createdBy', header: 'Registró', type: 'text' },
        { key: 'payment', header: 'Pago', type: 'text' },
        { key: 'amount', header: 'Importe', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const rows = await loadExpenses(range);
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: rows.map((row) => ({ ...row })),
            emptyMessage: 'Sin gastos registrados en el periodo.',
            notes: ['Retiros y depósitos de caja no son gastos y no se incluyen.'],
        };
    },
};

export const gastosCategoria: ReportDefinition = {
    key: 'gastos-categoria',
    title: 'Gastos por categoría',
    columns: [
        { key: 'category', header: 'Categoría', type: 'text' },
        { key: 'count', header: 'Gastos', type: 'int', total: true },
        { key: 'amount', header: 'Total', type: 'money', total: true },
        { key: 'share', header: 'Participación', type: 'percent' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const expenses = await loadExpenses(range);
        const byCategory = new Map<string, { count: number; cents: number }>();
        for (const row of expenses) {
            const entry = byCategory.get(row.category) ?? { count: 0, cents: 0 };
            entry.count += 1;
            entry.cents += toCents(row.amount);
            byCategory.set(row.category, entry);
        }
        const totalCents = expenses.reduce((total, row) => total + toCents(row.amount), 0);
        const rows = [...byCategory.entries()]
            .sort((a, b) => b[1].cents - a[1].cents)
            .map(([category, entry]) => ({
                category,
                count: entry.count,
                amount: fromCents(entry.cents),
                share: percentOf(entry.cents, totalCents),
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin gastos en el periodo.',
        };
    },
};

export const impuestos: ReportDefinition = {
    key: 'impuestos',
    title: 'Impuestos IVA e IEPS',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'sales', header: 'Ventas', type: 'int', total: true },
        { key: 'base', header: 'Base', type: 'money', total: true },
        { key: 'ieps', header: 'IEPS', type: 'money', total: true },
        { key: 'iva', header: 'IVA', type: 'money', total: true },
        { key: 'total', header: 'Total cobrado', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const [{ items: sales }, returns] = await Promise.all([
            salesRepo.listSales({ from: range.from, to: range.to }),
            returnsRepo.listSaleReturns({ from: range.from, to: range.to }),
        ]);
        interface Day { sales: number; base: number; ieps: number; iva: number; total: number }
        const days = new Map<string, Day>();
        const dayOf = (ms: number): Day => {
            const key = getZonedYmd(ms, REPORTS_TIME_ZONE);
            const day = days.get(key) ?? { sales: 0, base: 0, ieps: 0, iva: 0, total: 0 };
            days.set(key, day);
            return day;
        };
        let withoutBreakdown = 0;
        for (const sale of sales) {
            const day = dayOf(sale.createdAt.toMillis());
            day.sales += 1;
            day.total += toCents(sale.total);
            if (!sale.taxSummary) {
                withoutBreakdown += 1;
                continue;
            }
            day.base += toCents(sale.taxSummary.base);
            day.ieps += toCents(sale.taxSummary.iepsTotal);
            day.iva += toCents(sale.taxSummary.ivaTotal);
        }
        // Lo devuelto se resta el día de la devolución: es cuando se reembolsa.
        for (const saleReturn of returns) {
            const day = dayOf(saleReturn.createdAt.toMillis());
            day.total -= toCents(saleReturn.refundTotal);
            day.base -= toCents(saleReturn.taxSummary.base);
            day.ieps -= toCents(saleReturn.taxSummary.iepsTotal);
            day.iva -= toCents(saleReturn.taxSummary.ivaTotal);
        }
        const rows = [...days.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([key, day]) => ({
                date: ymdToDisplay(key),
                sales: day.sales,
                base: fromCents(day.base),
                ieps: fromCents(day.ieps),
                iva: fromCents(day.iva),
                total: fromCents(day.total),
            }));
        const notes = [
            'Los precios incluyen impuestos: base, IEPS e IVA se desglosan hacia atrás. '
            + 'Las devoluciones se restan el día en que se reembolsaron.',
        ];
        if (withoutBreakdown > 0) {
            notes.push(
                `${withoutBreakdown} ventas anteriores al desglose fiscal cuentan en el total `
                + 'cobrado pero no en base, IEPS ni IVA.',
            );
        }
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            notes,
            emptyMessage: 'Sin ventas en el periodo.',
        };
    },
};

export const devoluciones: ReportDefinition = {
    key: 'devoluciones',
    title: 'Devoluciones',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'time', header: 'Hora', type: 'text' },
        { key: 'folio', header: 'Folio', type: 'text' },
        { key: 'sale', header: 'Venta', type: 'text' },
        { key: 'method', header: 'Reembolso', type: 'text' },
        { key: 'reason', header: 'Motivo', type: 'text' },
        { key: 'createdBy', header: 'Registró', type: 'text' },
        { key: 'amount', header: 'Importe', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const returns = await returnsRepo.listSaleReturns({ from: range.from, to: range.to });
        const names = await resolveUserNames(returns.map((item) => item.createdBy));
        const rows = [...returns]
            .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
            .map((item) => ({
                date: stampDate(item.createdAt),
                time: stampTime(item.createdAt),
                folio: item.folio,
                sale: item.saleFolio,
                method: REFUND_METHOD_LABELS[item.refundMethod] ?? item.refundMethod,
                reason: item.reason,
                createdBy: names.get(item.createdBy) ?? NO_CASHIER,
                amount: item.refundTotal,
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin devoluciones en el periodo.',
        };
    },
};

export const cancelaciones: ReportDefinition = {
    key: 'cancelaciones',
    title: 'Ventas canceladas',
    columns: [
        { key: 'date', header: 'Fecha de venta', type: 'text' },
        { key: 'folio', header: 'Folio', type: 'text' },
        { key: 'cashier', header: 'Cobró', type: 'text' },
        { key: 'payment', header: 'Pago', type: 'text' },
        { key: 'voidedBy', header: 'Canceló', type: 'text' },
        { key: 'voidedAt', header: 'Fecha de cancelación', type: 'text' },
        { key: 'amount', header: 'Importe', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const { items } = await listVoidedSales(range);
        const names = await resolveUserNames(
            items.flatMap((sale) => [sale.cashierId, sale.voidedBy ?? '']),
        );
        const rows = [...items]
            .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
            .map((sale) => ({
                date: `${stampDate(sale.createdAt)} ${stampTime(sale.createdAt)}`,
                folio: sale.folio,
                cashier: names.get(sale.cashierId) ?? NO_CASHIER,
                payment: PAYMENT_METHOD_LABELS[sale.paymentMethod] ?? sale.paymentMethod,
                voidedBy: sale.voidedBy ? names.get(sale.voidedBy) ?? NO_CASHIER : NO_CASHIER,
                voidedAt: sale.voidedAt
                    ? `${stampDate(sale.voidedAt)} ${stampTime(sale.voidedAt)}`
                    : '',
                amount: sale.total,
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin ventas canceladas en el periodo.',
            notes: ['El periodo filtra por la fecha de la venta. El sistema no guarda el motivo '
                + 'de la cancelación; consulta la bitácora de auditoría.'],
        };
    },
};

const listVoidedSales = async (range: { from: string; to: string }) => {
    const { items } = await salesRepo.listSales({
        from: range.from,
        to: range.to,
        includeVoided: true,
    });
    return { items: items.filter((sale) => sale.voidedAt) };
};

export const metodosPago: ReportDefinition = {
    key: 'metodos-pago',
    title: 'Ventas por método de pago',
    columns: [
        { key: 'method', header: 'Método', type: 'text' },
        { key: 'count', header: 'Ventas', type: 'int', total: true },
        { key: 'total', header: 'Total', type: 'money', total: true },
        { key: 'share', header: 'Participación', type: 'percent' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const summary = await getSalesSummary({ from: range.from, to: range.to });
        const totalCents = summary.byPaymentMethod
            .reduce((total, item) => total + toCents(item.total), 0);
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: summary.byPaymentMethod.map((item) => ({
                method: item.label,
                count: item.count,
                total: item.total,
                share: percentOf(toCents(item.total), totalCents),
            })),
            emptyMessage: 'Sin ventas en el periodo.',
            notes: ['Mercado Pago Point se cuenta como Tarjeta: el sistema no separa terminal ni '
                + 'registra comisiones.'],
        };
    },
};

export const financialDefinitions: ReportDefinition[] = [
    ventas,
    utilidad,
    corteCaja,
    gastos,
    gastosCategoria,
    impuestos,
    devoluciones,
    cancelaciones,
    metodosPago,
];
