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
        ['Ticket promedio', formatCurrency(report.ticketAverage)],
        ['Devoluciones', `- ${formatCurrency(report.refundTotal)}`],
        ['Gastos del periodo', `- ${formatCurrency(report.expenses.total)}`],
        ['Resultado (vendido - devoluciones - gastos)', formatCurrency(report.netResult)],
        ...report.totals.byPaymentMethod.map((entry) => [
            `${entry.label} (${entry.count})`,
            formatCurrency(entry.amount),
        ]),
    ];
    if (report.kind === 'monthly') {
        rows.push([
            `Mes anterior (${report.previousMonth.periodLabel})`,
            formatCurrency(report.previousMonth.total),
        ]);
        if (report.previousMonth.changeRate !== null) {
            const rate = report.previousMonth.changeRate;
            rows.push(['Variación mensual', `${rate > 0 ? '+' : ''}${rate.toFixed(1)} %`]);
        }
        if (report.bestDay) {
            rows.push([
                `Mejor día (${report.bestDay.dateLabel})`,
                formatCurrency(report.bestDay.amount),
            ]);
        }
        rows.push(['Promedio por día con ventas', formatCurrency(report.dailyAverage)]);
    }
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
    const title = report.kind === 'monthly'
        ? 'Top 10 productos del mes'
        : 'Productos más vendidos';
    return `
        <h2>${escapeHtml(title)}</h2>
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

/** Farmacia vs consultorio: la separación que pidió la administración. */
const buildBranchesSection = (report: SalesReport): string => {
    const { pharmacy, services } = report.branches;
    return `
        <h2>Farmacia y consultorio</h2>
        <table>
            <thead>
                <tr>
                    <th>Rama</th>
                    <th class="num">Ventas</th>
                    <th class="num">Importe</th>
                    <th class="num">Participación</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Farmacia (mercancía)</td>
                    <td class="num">${pharmacy.salesCount}</td>
                    <td class="num">${escapeHtml(formatCurrency(pharmacy.total))}</td>
                    <td class="num">${pharmacy.share.toFixed(1)} %</td>
                </tr>
                <tr>
                    <td>Consultorio (servicios)</td>
                    <td class="num">${services.salesCount}</td>
                    <td class="num">${escapeHtml(formatCurrency(services.total))}</td>
                    <td class="num">${services.share.toFixed(1)} %</td>
                </tr>
                <tr>
                    <td>Comisiones de prestadores</td>
                    <td class="num">-</td>
                    <td class="num">${escapeHtml(formatCurrency(services.commissionTotal))}</td>
                    <td class="num">-</td>
                </tr>
            </tbody>
        </table>
        <p class="empty">
            Una venta puede incluir mercancía y servicio: por eso las ventas de cada
            rama pueden sumar más que el total de ventas del periodo.
        </p>`;
};

const buildExpensesSection = (report: SalesReport): string => {
    if (!report.expenses.byCategory.length) {
        return '<h2>Gastos</h2><p class="empty">Sin gastos registrados en el periodo.</p>';
    }

    const rows = report.expenses.byCategory
        .map(
            (entry) => `
            <tr>
                <td>${escapeHtml(entry.label)}</td>
                <td class="num">${entry.count}</td>
                <td class="num">${escapeHtml(formatCurrency(entry.amount))}</td>
                <td class="num">${entry.share.toFixed(1)} %</td>
            </tr>`,
        )
        .join('');

    const detailRows = report.kind === 'daily'
        ? report.expenseRows.map((expense) => {
            const concept = [expense.reason, expense.description].filter(Boolean).join(' — ');
            return `
                <tr>
                    <td>${escapeHtml(expense.time)}</td>
                    <td>${escapeHtml(expense.categoryLabel)}</td>
                    <td>${escapeHtml(concept)}</td>
                    <td>${escapeHtml(expense.createdByLabel ?? '-')}</td>
                    <td class="num">${escapeHtml(formatCurrency(expense.amount))}</td>
                </tr>`;
        }).join('')
        : '';

    const detail = detailRows
        ? `
        <h2>Detalle de gastos</h2>
        <table>
            <thead>
                <tr>
                    <th>Hora</th>
                    <th>Categoría</th>
                    <th>Concepto</th>
                    <th>Registró</th>
                    <th class="num">Importe</th>
                </tr>
            </thead>
            <tbody>${detailRows}</tbody>
        </table>`
        : '';

    return `
        <h2>Gastos por categoría</h2>
        <table>
            <thead>
                <tr>
                    <th>Categoría</th>
                    <th class="num">Movimientos</th>
                    <th class="num">Importe</th>
                    <th class="num">Participación</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
                <tr>
                    <td><strong>Total</strong></td>
                    <td class="num"><strong>${report.expenses.count}</strong></td>
                    <td class="num">
                        <strong>${escapeHtml(formatCurrency(report.expenses.total))}</strong>
                    </td>
                    <td class="num">100 %</td>
                </tr>
            </tbody>
        </table>${detail}`;
};

const buildTopServicesSection = (report: SalesReport): string => {
    if (report.kind !== 'monthly' || !report.topServices.length) {
        return '';
    }
    const rows = report.topServices
        .map(
            (service) => `
            <tr>
                <td>${escapeHtml(service.name)}</td>
                <td class="num">${service.quantity}</td>
                <td class="num">${escapeHtml(formatCurrency(service.amount))}</td>
            </tr>`,
        )
        .join('');
    return `
        <h2>Servicios más cobrados</h2>
        <table>
            <thead>
                <tr><th>Servicio</th><th class="num">Cantidad</th><th class="num">Importe</th></tr>
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
  ${buildBranchesSection(report)}
  ${buildExpensesSection(report)}
  ${buildTopProductsSection(report)}
  ${buildTopServicesSection(report)}
  <h2>${escapeHtml(detailTitle)}</h2>
  ${buildDetailSection(report)}
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
