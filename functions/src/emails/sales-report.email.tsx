import {
    Body,
    Container,
    Head,
    Heading,
    Hr,
    Html,
    Preview,
    Row,
    Section,
    Text,
} from '@react-email/components';
import { SalesReport } from '../services/sales-reports.service';
import { formatCurrency } from '../utils/currency';
import {
    BranchCard,
    DataRow,
    DataTable,
    EmptyState,
    HeroMetric,
    MetricRow,
    ReportSection,
    TotalRow,
    palette,
    text,
} from './components/report-ui';

/**
 * Correo del reporte diario y mensual.
 *
 * Jerarquía deliberada: primero **cuánto quedó** (resultado neto), luego de dónde
 * vino (farmacia vs consultorio), luego a dónde se fue (gastos por categoría) y
 * al final el detalle. El admin lee esto en el teléfono a las 00:10; el orden
 * está pensado para que las tres primeras pantallas ya respondan la pregunta.
 */

export interface SalesReportEmailProps {
    report: SalesReport;
}

const percentLabel = (value: number | null): string =>
    value === null ? 'sin comparativo' : `${value > 0 ? '+' : ''}${value.toFixed(1)} %`;

export const SalesReportEmail = ({ report }: SalesReportEmailProps) => {
    const { totals, branches, expenses } = report;
    const netTone = report.netResult >= 0 ? palette.positive : palette.negative;

    const expenseRows: DataRow[] = expenses.byCategory.map((entry) => ({
        key: entry.category,
        label: entry.label,
        sublabel: `${entry.count} ${entry.count === 1 ? 'movimiento' : 'movimientos'}`,
        value: formatCurrency(entry.amount),
        percent: entry.share,
        color: palette.expense,
    }));

    const maxProduct = report.topProducts[0]?.amount ?? 0;
    const productRows: DataRow[] = report.topProducts.map((product, index) => ({
        key: product.productId,
        rank: index + 1,
        label: product.name,
        sublabel: `${product.quantity} u`,
        value: formatCurrency(product.amount),
        percent: maxProduct > 0 ? (product.amount / maxProduct) * 100 : 0,
        color: palette.pharmacy,
    }));

    const paymentRows: DataRow[] = totals.byPaymentMethod.map((entry) => ({
        key: entry.method,
        label: entry.label,
        sublabel: `${entry.count} ${entry.count === 1 ? 'venta' : 'ventas'}`,
        value: formatCurrency(entry.amount),
    }));

    return (
        <Html lang="es">
            <Head />
            <Preview>
                {`${report.periodLabel}: ${formatCurrency(totals.totalAmount)} vendido · ` +
                    `${formatCurrency(expenses.total)} en gastos · ` +
                    `neto ${formatCurrency(report.netResult)}`}
            </Preview>
            <Body
                style={{
                    backgroundColor: palette.canvas,
                    fontFamily: 'Helvetica, Arial, sans-serif',
                    margin: 0,
                    padding: '24px 0',
                }}
            >
                <Container
                    style={{
                        backgroundColor: palette.surface,
                        borderRadius: '12px',
                        margin: '0 auto',
                        maxWidth: '600px',
                        padding: '32px',
                    }}
                >
                    <Text style={text.brand}>FarmaJyV</Text>
                    <Heading as="h1" style={text.title}>{report.title}</Heading>
                    <Text style={text.period}>{report.periodLabel}</Text>

                    <HeroMetric
                        label="Resultado del periodo (vendido − devoluciones − gastos)"
                        value={formatCurrency(report.netResult)}
                        tone={netTone}
                        caption={
                            `${formatCurrency(totals.totalAmount)} vendido · ` +
                            `${formatCurrency(report.refundTotal)} devuelto · ` +
                            `${formatCurrency(expenses.total)} gastado`
                        }
                    />

                    <MetricRow
                        metrics={[
                            { label: 'Ventas', value: String(totals.salesCount) },
                            {
                                label: 'Ticket promedio',
                                value: formatCurrency(report.ticketAverage),
                            },
                            {
                                label: 'Anuladas',
                                value: String(totals.voidedCount),
                                tone: totals.voidedCount > 0 ? palette.negative : palette.ink,
                            },
                        ]}
                    />

                    {report.kind === 'monthly' ? (
                        <MetricRow
                            metrics={[
                                {
                                    label: `vs ${report.previousMonth.periodLabel}`,
                                    value: percentLabel(report.previousMonth.changeRate),
                                    tone: (report.previousMonth.changeRate ?? 0) >= 0
                                        ? palette.positive
                                        : palette.negative,
                                },
                                {
                                    label: 'Promedio por día con ventas',
                                    value: formatCurrency(report.dailyAverage),
                                },
                                {
                                    label: report.bestDay
                                        ? `Mejor día · ${report.bestDay.dateLabel}`
                                        : 'Mejor día',
                                    value: report.bestDay
                                        ? formatCurrency(report.bestDay.amount)
                                        : '—',
                                },
                            ]}
                        />
                    ) : null}

                    <ReportSection title="Farmacia vs consultorio">
                        <Row>
                            <BranchCard
                                label="Farmacia"
                                total={branches.pharmacy.total}
                                share={branches.pharmacy.share}
                                caption={`${branches.pharmacy.salesCount} ventas con mercancía`}
                                color={palette.pharmacy}
                            />
                            <BranchCard
                                label="Consultorio"
                                total={branches.services.total}
                                share={branches.services.share}
                                caption={
                                    `${branches.services.salesCount} con servicios · ` +
                                    `${formatCurrency(branches.services.commissionTotal)} ` +
                                    'en comisiones'
                                }
                                color={palette.services}
                            />
                        </Row>
                    </ReportSection>

                    <ReportSection title="Gastos por categoría">
                        {expenseRows.length > 0 ? (
                            <>
                                <DataTable rows={expenseRows} />
                                <TotalRow
                                    label={`Total gastado (${expenses.count})`}
                                    value={formatCurrency(expenses.total)}
                                    tone={palette.expense}
                                />
                            </>
                        ) : (
                            <EmptyState>Sin gastos registrados en el periodo.</EmptyState>
                        )}
                    </ReportSection>

                    {paymentRows.length > 0 ? (
                        <ReportSection title="Cobro por método de pago">
                            <DataTable rows={paymentRows} />
                        </ReportSection>
                    ) : null}

                    <ReportSection
                        title={
                            report.kind === 'monthly'
                                ? 'Top 10 productos del mes'
                                : 'Productos más vendidos'
                        }
                    >
                        {productRows.length > 0 ? (
                            <DataTable rows={productRows} />
                        ) : (
                            <EmptyState>Sin ventas de mercancía en el periodo.</EmptyState>
                        )}
                    </ReportSection>

                    {report.kind === 'monthly' && report.topServices.length > 0 ? (
                        <ReportSection title="Servicios más cobrados">
                            <DataTable
                                rows={report.topServices.map((service, index) => ({
                                    key: service.serviceId,
                                    rank: index + 1,
                                    label: service.name,
                                    sublabel: `${service.quantity} servicios`,
                                    value: formatCurrency(service.amount),
                                    color: palette.services,
                                }))}
                            />
                        </ReportSection>
                    ) : null}

                    {report.kind === 'daily' && report.expenseRows.length > 0 ? (
                        <ReportSection title="Detalle de gastos del día">
                            <DataTable
                                rows={report.expenseRows.map((expense, index) => ({
                                    key: `${expense.time}-${index}`,
                                    label: `${expense.time} · ${expense.categoryLabel}`,
                                    sublabel: [
                                        expense.reason,
                                        expense.description,
                                        expense.createdByLabel,
                                    ].filter(Boolean).join(' · '),
                                    value: formatCurrency(expense.amount),
                                }))}
                            />
                        </ReportSection>
                    ) : null}

                    {report.kind === 'monthly' && report.byDay.length > 0 ? (
                        <ReportSection title="Ventas por día">
                            <DataTable
                                rows={report.byDay.map((day) => ({
                                    key: day.dateLabel,
                                    label: day.dateLabel,
                                    sublabel: `${day.count} ventas`,
                                    value: formatCurrency(day.amount),
                                }))}
                            />
                        </ReportSection>
                    ) : null}

                    <Section>
                        <Hr style={{ borderColor: palette.line, margin: '24px 0 0' }} />
                        <Text style={text.note}>
                            El detalle completo va en el PDF adjunto. Los gastos son
                            movimientos de caja de tipo gasto: los retiros y depósitos
                            mueven efectivo entre cajón y bóveda y no cuentan como gasto.
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
};

export default SalesReportEmail;
