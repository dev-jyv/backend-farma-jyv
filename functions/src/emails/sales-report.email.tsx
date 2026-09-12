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
import { MonthlySalesReport, SalesReport } from '../services/sales-reports.service';
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

/** Diferencia en pesos contra el mes anterior. */
const monthDelta = (report: MonthlySalesReport): number =>
    report.totals.totalAmount - report.previousMonth.total;

const monthDeltaLabel = (report: MonthlySalesReport): string => {
    const delta = monthDelta(report);
    return `${delta >= 0 ? '+' : '−'}${formatCurrency(Math.abs(delta))}`;
};

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
    // Escala de la gráfica de días: el mejor día del mes es la barra llena.
    const maxDay = report.kind === 'monthly'
        ? Math.max(0, ...report.byDay.map((day) => day.amount))
        : 0;
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
                                // El conteo solo no dice nada: dos anuladas de
                                // $80 y dos de $9,000 se leen igual. Va el importe.
                                label: 'Anuladas',
                                value: totals.voidedCount > 0
                                    ? `${totals.voidedCount} · ` +
                                        `${formatCurrency(totals.voidedAmount)}`
                                    : '0',
                                tone: totals.voidedCount > 0 ? palette.negative : palette.ink,
                            },
                        ]}
                    />

                    {report.kind === 'monthly' ? (
                        <MetricRow
                            metrics={[
                                {
                                    /**
                                     * La pregunta de un reporte mensual es "¿mejor
                                     * o peor?". Un porcentaje solo no se puede
                                     * juzgar —+12 % sobre un mes malo sigue siendo
                                     * un mes malo—, así que va con la diferencia
                                     * en pesos, que es la cifra que se compara
                                     * contra la renta y la nómina.
                                     */
                                    label: `vs ${report.previousMonth.periodLabel} ` +
                                        `(${formatCurrency(report.previousMonth.total)})`,
                                    value: `${monthDeltaLabel(report)} · ` +
                                        percentLabel(report.previousMonth.changeRate),
                                    tone: monthDelta(report) >= 0
                                        ? palette.positive
                                        : palette.negative,
                                },
                                {
                                    label: 'Promedio por día con ventas ' +
                                        `(${report.byDay.length})`,
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
                            {/*
                              * Con barra proporcional en vez de treinta importes
                              * sueltos: la forma del mes —qué semana cargó, qué
                              * día se cayó— se ve de un vistazo y no hay que
                              * comparar cifras a mano. La escala es contra el
                              * mejor día, así que la barra llena es ese día.
                              */}
                            <DataTable
                                rows={report.byDay.map((day) => ({
                                    key: day.dateLabel,
                                    label: day.dateLabel,
                                    sublabel: `${day.count} ventas`,
                                    value: formatCurrency(day.amount),
                                    percent: maxDay > 0 ? (day.amount / maxDay) * 100 : 0,
                                    color: palette.pharmacy,
                                }))}
                            />
                            {/*
                              * `byDay` solo trae días con ventas: un día cerrado
                              * desaparece de la tabla en vez de salir en cero. Se
                              * dice, para que nadie cuente renglones y crea que el
                              * mes tuvo esos días.
                              */}
                            <Text style={text.note}>
                                {`Solo se listan los ${report.byDay.length} días con ventas; ` +
                                    'los días sin movimiento no aparecen.'}
                            </Text>
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
