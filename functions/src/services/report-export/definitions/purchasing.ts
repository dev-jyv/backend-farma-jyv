import * as entriesRepo from '../../../repositories/inventory-entries.repository';
import * as invoicesRepo from '../../../repositories/invoices.repository';
import * as suppliersRepo from '../../../repositories/suppliers.repository';
import { fromCents, toCents } from '../../../utils/taxes';
import { getPayables } from '../../accounting.service';
import { buildInvoiceRows, resolveUserNames } from '../../module-reports.service';
import { ReportDefinition } from '../report-definition';
import { resolveReportPeriod } from '../period';
import { ymdToDisplay } from './shared';

export const facturas: ReportDefinition = {
    key: 'facturas',
    title: 'Facturas de proveedores',
    columns: [
        { key: 'supplier', header: 'Proveedor', type: 'text' },
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'number', header: 'No. de factura', type: 'text' },
        { key: 'total', header: 'Total', type: 'money', total: true },
        { key: 'registeredBy', header: 'Registró', type: 'text' },
        { key: 'registeredAt', header: 'Registrada', type: 'text' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const invoices = (await invoicesRepo.listInvoices({ from: range.from, to: range.to }))
            .sort((a, b) => a.invoiceDate.toMillis() - b.invoiceDate.toMillis());
        const [suppliers, names] = await Promise.all([
            suppliersRepo.getSuppliersByIds(invoices.map((invoice) => invoice.supplierId)),
            resolveUserNames(invoices.map((invoice) => invoice.createdBy)),
        ]);
        const rows = buildInvoiceRows(invoices, suppliers, names).map((row, index) => ({
            ...row,
            total: invoices[index].totalAmount,
        }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin facturas registradas en el periodo.',
        };
    },
};

export const comprasProveedor: ReportDefinition = {
    key: 'compras-proveedor',
    title: 'Compras por proveedor',
    columns: [
        { key: 'supplier', header: 'Proveedor', type: 'text' },
        { key: 'entries', header: 'Entradas', type: 'int', total: true },
        { key: 'units', header: 'Unidades', type: 'int', total: true },
        { key: 'amount', header: 'Importe a costo', type: 'money', total: true },
        { key: 'unitsWithoutCost', header: 'Unidades sin costo', type: 'int', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const entries = await entriesRepo.listInventoryEntries({ from: range.from, to: range.to });
        const suppliers = await suppliersRepo.getSuppliersByIds(
            entries.map((entry) => entry.supplierId),
        );
        interface Line { entries: number; units: number; cents: number; noCost: number }
        const bySupplier = new Map<string, Line>();
        for (const entry of entries) {
            const line = bySupplier.get(entry.supplierId)
                ?? { entries: 0, units: 0, cents: 0, noCost: 0 };
            line.entries += 1;
            for (const item of entry.items) {
                line.units += item.quantity;
                if (item.costPrice === undefined || item.costPrice === null) {
                    line.noCost += item.quantity;
                } else {
                    line.cents += toCents(item.costPrice) * item.quantity;
                }
            }
            bySupplier.set(entry.supplierId, line);
        }
        const rows = [...bySupplier.entries()]
            .sort((a, b) => b[1].cents - a[1].cents)
            .map(([supplierId, line]) => ({
                supplier: suppliers.get(supplierId)?.name ?? 'Proveedor eliminado',
                entries: line.entries,
                units: line.units,
                amount: fromCents(line.cents),
                unitsWithoutCost: line.noCost,
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin entradas de inventario en el periodo.',
            notes: ['El importe es cantidad por costo capturado en cada entrada, sin impuestos.'],
        };
    },
};

export const cuentasPorPagar: ReportDefinition = {
    key: 'cuentas-por-pagar',
    title: 'Cuentas por pagar',
    columns: [
        { key: 'supplier', header: 'Proveedor', type: 'text' },
        { key: 'number', header: 'No. de factura', type: 'text' },
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'due', header: 'Vencimiento', type: 'text' },
        { key: 'total', header: 'Total', type: 'money', total: true },
        { key: 'paid', header: 'Pagado', type: 'money', total: true },
        { key: 'balance', header: 'Saldo', type: 'money', total: true },
        { key: 'daysOverdue', header: 'Días vencida', type: 'int' },
        { key: 'bucket', header: 'Antigüedad', type: 'text' },
    ],
    load: async ({ now }) => {
        const report = await getPayables();
        const labels = new Map(report.buckets.map((bucket) => [bucket.bucket, bucket.label]));
        return {
            subtitle: `Saldos pendientes al ${ymdToDisplay(report.asOf)}`,
            slug: report.asOf.slice(0, 10) || now.toISOString().slice(0, 10),
            rows: report.invoices.map((invoice) => ({
                supplier: invoice.supplierName,
                number: invoice.invoiceNumber,
                date: ymdToDisplay(invoice.invoiceDate),
                due: invoice.dueDate ? ymdToDisplay(invoice.dueDate) : 'Sin plazo',
                total: invoice.totalAmount,
                paid: invoice.paidTotal,
                balance: invoice.balance,
                daysOverdue: invoice.daysOverdue,
                bucket: labels.get(invoice.bucket) ?? invoice.bucket,
            })),
            emptyMessage: 'No hay saldos pendientes con proveedores.',
        };
    },
};

export const purchasingDefinitions: ReportDefinition[] = [
    facturas,
    comprasProveedor,
    cuentasPorPagar,
];
