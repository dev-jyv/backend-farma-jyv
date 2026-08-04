import { SalesReport } from './sales-reports.service';
import { formatCurrency } from '../utils/currency';

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const isServerless = (): boolean =>
    Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET);

const launchBrowser = async () => {
    if (isServerless()) {
        const chromium = (await import('@sparticuz/chromium')).default;
        const puppeteer = (await import('puppeteer-core')).default;
        return puppeteer.launch({
            args: [...chromium.args, '--disable-dev-shm-usage'],
            executablePath: await chromium.executablePath(),
            headless: true,
        });
    }

    const puppeteer = (await import('puppeteer')).default;
    return puppeteer.launch({ headless: true });
};

const buildSummaryRows = (report: SalesReport): string => {
    const rows = [
        ['Ventas registradas', String(report.totals.salesCount)],
        ['Total vendido', formatCurrency(report.totals.totalAmount)],
        ...report.totals.byPaymentMethod.map((entry) => [
            `${entry.label} (${entry.count})`,
            formatCurrency(entry.amount),
        ]),
    ];
    if (report.totals.voidedCount > 0) {
        rows.push([
            `Ventas anuladas (${report.totals.voidedCount})`,
            formatCurrency(report.totals.voidedAmount),
        ]);
    }
    return rows
        .map(
            ([label, value]) =>
                `<tr><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(value)}</td></tr>`,
        )
        .join('');
};

const buildDetailSection = (report: SalesReport): string => {
    if (report.kind === 'daily') {
        if (!report.sales.length) {
            return '<p class="empty">Sin ventas registradas en el día.</p>';
        }
        const rows = report.sales
            .map(
                (sale) => `
            <tr>
                <td>${escapeHtml(sale.folio)}</td>
                <td>${escapeHtml(sale.time)}</td>
                <td>${escapeHtml(sale.paymentMethodLabel)}</td>
                <td class="num">${escapeHtml(formatCurrency(sale.total))}</td>
            </tr>`,
            )
            .join('');
        return `
            <table>
                <thead>
                    <tr>
                        <th>Folio</th>
                        <th>Hora</th>
                        <th>Método de pago</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    if (!report.byDay.length) {
        return '<p class="empty">Sin ventas registradas en el mes.</p>';
    }
    const rows = report.byDay
        .map(
            (day) => `
            <tr>
                <td>${escapeHtml(day.dateLabel)}</td>
                <td class="num">${day.count}</td>
                <td class="num">${escapeHtml(formatCurrency(day.amount))}</td>
            </tr>`,
        )
        .join('');
    return `
        <table>
            <thead>
                <tr>
                    <th>Día</th>
                    <th>Ventas</th>
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
};

const buildTopProductsSection = (report: SalesReport): string => {
    if (!report.topProducts.length) {
        return '';
    }
    const rows = report.topProducts
        .map(
            (product) => `
            <tr>
                <td>${escapeHtml(product.name)}</td>
                <td class="num">${product.quantity}</td>
                <td class="num">${escapeHtml(formatCurrency(product.amount))}</td>
            </tr>`,
        )
        .join('');
    return `
        <h2>Productos más vendidos</h2>
        <table>
            <thead>
                <tr>
                    <th>Producto</th>
                    <th>Cantidad</th>
                    <th>Importe</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
};

const buildReportHtml = (report: SalesReport): string => {
    const detailTitle = report.kind === 'daily' ? 'Detalle de ventas' : 'Ventas por día';
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<style>
  body {
    font-family: Helvetica, Arial, sans-serif;
    color: #111827;
    font-size: 12px;
    margin: 0;
    padding: 32px 40px;
  }
  .brand {
    color: #166534;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0;
  }
  h1 {
    font-size: 20px;
    margin: 6px 0 0;
  }
  .period {
    color: #555555;
    font-size: 12px;
    margin: 4px 0 16px;
    text-transform: capitalize;
  }
  h2 {
    font-size: 14px;
    margin: 20px 0 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    border-bottom: 1px solid #e5e7eb;
    padding: 8px 6px;
    text-align: left;
    vertical-align: top;
  }
  th {
    font-weight: 700;
  }
  td.num, th.num {
    text-align: right;
  }
  .empty {
    color: #6b7280;
    font-style: italic;
  }
</style>
</head>
<body>
  <p class="brand">FarmaJyV</p>
  <h1>${escapeHtml(report.title)}</h1>
  <p class="period">${escapeHtml(report.periodLabel)}</p>
  <h2>Resumen</h2>
  <table>
    <thead>
      <tr><th>Concepto</th><th class="num">Valor</th></tr>
    </thead>
    <tbody>${buildSummaryRows(report)}</tbody>
  </table>
  <h2>${escapeHtml(detailTitle)}</h2>
  ${buildDetailSection(report)}
  ${buildTopProductsSection(report)}
</body>
</html>`;
};

export const buildReportPdf = async (report: SalesReport): Promise<Buffer> => {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage();
        await page.setContent(buildReportHtml(report), { waitUntil: 'load' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '16mm', right: '12mm', bottom: '16mm', left: '12mm' },
        });
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
};
