import {
    Body,
    Container,
    Head,
    Heading,
    Hr,
    Html,
    Preview,
    Section,
    Text,
} from '@react-email/components';
import { InventoryAlerts } from '../types';

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
    sectionTitle: {
        color: '#111827',
        fontSize: '15px',
        fontWeight: 700 as const,
        margin: '20px 0 6px',
    },
    urgent: {
        color: '#b91c1c',
    },
    line: {
        color: '#374151',
        fontSize: '13px',
        margin: '2px 0',
    },
    muted: {
        color: '#6b7280',
        fontSize: '12px',
        margin: '2px 0',
    },
    hr: {
        borderColor: '#e5e7eb',
        margin: '20px 0 0',
    },
};

/** Cuántos renglones se listan por sección antes de resumir el resto. */
const MAX_ROWS = 15;

const describeExpiring = (
    items: InventoryAlerts['expired'],
): Array<{ key: string; text: string }> => items.slice(0, MAX_ROWS).map((item) => ({
    key: item.batchId,
    text: `${item.productName} — lote ${item.lotNumber} · ${item.quantity} u · ` +
        (item.daysToExpiry <= 0
            ? `venció hace ${Math.abs(item.daysToExpiry)} d`
            : `caduca en ${item.daysToExpiry} d`),
}));

export const InventoryAlertsEmail = ({ alerts }: { alerts: InventoryAlerts }) => {
    const { totals } = alerts;

    return (
        <Html lang="es">
            <Head />
            <Preview>
                {`${totals.expiredBatches} vencidos · ${totals.expiringBatches} por vencer · ` +
                    `${totals.lowStockProducts} con stock bajo`}
            </Preview>
            <Body style={styles.body}>
                <Container style={styles.container}>
                    <Text style={styles.brand}>Farmacia JyV</Text>
                    <Heading style={styles.title}>Alertas de inventario</Heading>

                    {alerts.expired.length > 0 && (
                        <Section>
                            <Text style={{ ...styles.sectionTitle, ...styles.urgent }}>
                                {`Vencidos con existencia (${totals.expiredBatches} lotes, ` +
                                    `${totals.expiredUnits} u)`}
                            </Text>
                            {describeExpiring(alerts.expired).map((row) => (
                                <Text key={row.key} style={styles.line}>{row.text}</Text>
                            ))}
                            {alerts.expired.length > MAX_ROWS && (
                                <Text style={styles.muted}>
                                    {`y ${alerts.expired.length - MAX_ROWS} lotes más`}
                                </Text>
                            )}
                        </Section>
                    )}

                    {alerts.expiring.map((window) => window.items.length > 0 && (
                        <Section key={window.windowDays}>
                            <Text style={styles.sectionTitle}>
                                {`Caducan en ${window.windowDays} días ` +
                                    `(${window.items.length} lotes)`}
                            </Text>
                            {describeExpiring(window.items).map((row) => (
                                <Text key={row.key} style={styles.line}>{row.text}</Text>
                            ))}
                            {window.items.length > MAX_ROWS && (
                                <Text style={styles.muted}>
                                    {`y ${window.items.length - MAX_ROWS} lotes más`}
                                </Text>
                            )}
                        </Section>
                    ))}

                    {alerts.outOfStock.length > 0 && (
                        <Section>
                            <Text style={{ ...styles.sectionTitle, ...styles.urgent }}>
                                {`Agotados (${totals.outOfStockProducts})`}
                            </Text>
                            {alerts.outOfStock.slice(0, MAX_ROWS).map((item) => (
                                <Text key={item.productId} style={styles.line}>
                                    {`${item.productName} (${item.sku})`}
                                </Text>
                            ))}
                        </Section>
                    )}

                    {alerts.lowStock.length > 0 && (
                        <Section>
                            <Text style={styles.sectionTitle}>
                                {`Stock bajo (${totals.lowStockProducts})`}
                            </Text>
                            {alerts.lowStock.slice(0, MAX_ROWS).map((item) => (
                                <Text key={item.productId} style={styles.line}>
                                    {`${item.productName} — ${item.totalStock} u ` +
                                        `(mínimo ${item.minStock})`}
                                </Text>
                            ))}
                        </Section>
                    )}

                    <Hr style={styles.hr} />
                    <Text style={styles.muted}>
                        Generado automáticamente por el backend de Farmacia JyV.
                    </Text>
                </Container>
            </Body>
        </Html>
    );
};

export default InventoryAlertsEmail;
