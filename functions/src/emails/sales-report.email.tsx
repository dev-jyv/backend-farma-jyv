import {
    Body,
    Column,
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

const styles = {
    body: {
        backgroundColor: '#f4f7f5',
        fontFamily: 'Helvetica, Arial, sans-serif',
        margin: 0,
        padding: '24px 0',
    },
    container: {
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        margin: '0 auto',
        maxWidth: '560px',
        padding: '32px',
    },
    brand: {
        color: '#166534',
        fontSize: '13px',
        fontWeight: 700 as const,
        letterSpacing: '1px',
        margin: 0,
        textTransform: 'uppercase' as const,
    },
    title: {
        color: '#111827',
        fontSize: '22px',
        margin: '4px 0 0',
    },
    period: {
        color: '#6b7280',
        fontSize: '14px',
        margin: '4px 0 0',
        textTransform: 'capitalize' as const,
    },
    metricValue: {
        color: '#111827',
        fontSize: '20px',
        fontWeight: 700 as const,
        margin: 0,
    },
    metricLabel: {
        color: '#6b7280',
        fontSize: '12px',
        margin: '2px 0 0',
    },
    sectionTitle: {
        color: '#111827',
        fontSize: '15px',
        margin: '0 0 8px',
    },
    rowLabel: {
        color: '#374151',
        fontSize: '13px',
        margin: '2px 0',
    },
    rowValue: {
        color: '#111827',
        fontSize: '13px',
        margin: '2px 0',
        textAlign: 'right' as const,
    },
    note: {
        color: '#6b7280',
        fontSize: '12px',
        margin: '16px 0 0',
    },
};

export interface SalesReportEmailProps {
    report: SalesReport;
}

export const SalesReportEmail = ({ report }: SalesReportEmailProps) => (
    <Html lang="es">
        <Head />
        <Preview>
            {`${report.title} — ${report.periodLabel}: ` +
                `${formatCurrency(report.totals.totalAmount)}`}
        </Preview>
        <Body style={styles.body}>
            <Container style={styles.container}>
                <Text style={styles.brand}>FarmaJyV</Text>
                <Heading as="h1" style={styles.title}>{report.title}</Heading>
                <Text style={styles.period}>{report.periodLabel}</Text>

                <Hr />

                <Row>
                    <Column>
                        <Text style={styles.metricValue}>
                            {formatCurrency(report.totals.totalAmount)}
                        </Text>
                        <Text style={styles.metricLabel}>Total vendido</Text>
                    </Column>
                    <Column>
                        <Text style={styles.metricValue}>{report.totals.salesCount}</Text>
                        <Text style={styles.metricLabel}>Ventas</Text>
                    </Column>
                    <Column>
                        <Text style={styles.metricValue}>{report.totals.voidedCount}</Text>
                        <Text style={styles.metricLabel}>Anuladas</Text>
                    </Column>
                </Row>

                {report.totals.byPaymentMethod.length > 0 && (
                    <Section>
                        <Hr />
                        <Text style={styles.sectionTitle}>Por método de pago</Text>
                        {report.totals.byPaymentMethod.map((entry) => (
                            <Row key={entry.method}>
                                <Column>
                                    <Text style={styles.rowLabel}>
                                        {entry.label} ({entry.count})
                                    </Text>
                                </Column>
                                <Column>
                                    <Text style={styles.rowValue}>
                                        {formatCurrency(entry.amount)}
                                    </Text>
                                </Column>
                            </Row>
                        ))}
                    </Section>
                )}

                {report.kind === 'monthly' && report.byDay.length > 0 && (
                    <Section>
                        <Hr />
                        <Text style={styles.sectionTitle}>Ventas por día</Text>
                        {report.byDay.map((day) => (
                            <Row key={day.dateLabel}>
                                <Column>
                                    <Text style={styles.rowLabel}>
                                        {day.dateLabel} ({day.count})
                                    </Text>
                                </Column>
                                <Column>
                                    <Text style={styles.rowValue}>
                                        {formatCurrency(day.amount)}
                                    </Text>
                                </Column>
                            </Row>
                        ))}
                    </Section>
                )}

                <Text style={styles.note}>
                    El detalle completo de las ventas está en el PDF adjunto.
                </Text>
            </Container>
        </Body>
    </Html>
);
