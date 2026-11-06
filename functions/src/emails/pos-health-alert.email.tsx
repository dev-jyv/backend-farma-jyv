import {
    Body,
    Container,
    Head,
    Heading,
    Hr,
    Html,
    Preview,
    Text,
} from '@react-email/components';
import { ReactNode } from 'react';
import { BlockedSalesAlertReason } from '../services/pos-health-alerts.service';
import { formatCurrency } from '../utils/currency';
import {
    DataTable,
    HeroMetric,
    MetricRow,
    ReportSection,
    palette,
    text,
} from './components/report-ui';

/**
 * Alertas de salud de cajas (SPEC 44): una caja con turno abierto que dejó de
 * reportar, o una caja a la que le aparecieron (o crecieron) ventas bloqueadas.
 *
 * Los dos correos contestan lo mismo en el mismo orden —qué caja, desde cuándo,
 * cuánto dinero está en juego— porque quien los lee decide en el teléfono si
 * va a la caja o no. El detalle completo está en la tarjeta "Cajas" del panel.
 */

/** Renglones de ventas bloqueadas: lo que no cabe en una pantalla no se lee. */
const MAX_ROWS = 8;

const Layout = ({
    preview,
    title,
    children,
}: { preview: string; title: string; children: ReactNode }) => (
    <Html lang="es">
        <Head />
        <Preview>{preview}</Preview>
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
                    borderRadius: '10px',
                    margin: '0 auto',
                    maxWidth: '600px',
                    padding: '32px',
                }}
            >
                <Text style={text.brand}>Farmacia JyV</Text>
                <Heading style={text.title}>{title}</Heading>
                {children}
                <Hr style={{ borderColor: palette.line, margin: '26px 0 0' }} />
                <Text style={text.note}>
                    El estado de todas las cajas está en la tarjeta «Cajas» del tablero del
                    panel. Desde ahí se pueden reintentar las ventas bloqueadas a distancia.
                </Text>
            </Container>
        </Body>
    </Html>
);

const countMetrics = (pendingSalesCount: number, blockedSalesCount: number) => [
    {
        label: 'Ventas pendientes de subir',
        value: String(pendingSalesCount),
        tone: pendingSalesCount > 0 ? palette.expense : palette.muted,
    },
    {
        label: 'Ventas bloqueadas',
        value: String(blockedSalesCount),
        tone: blockedSalesCount > 0 ? palette.negative : palette.muted,
    },
];

export interface PosSilenceAlertEmailProps {
    deviceName: string;
    /** Último reporte, ya en hora local (`formatLocalDateTime`). */
    lastReportLocal: string;
    /** "3 h 10 min" sin reportar. */
    silentFor: string;
    pendingSalesCount: number;
    blockedSalesCount: number;
}

export const PosSilenceAlertEmail = ({
    deviceName,
    lastReportLocal,
    silentFor,
    pendingSalesCount,
    blockedSalesCount,
}: PosSilenceAlertEmailProps) => (
    <Layout
        preview={`La caja ${deviceName} tiene turno abierto y no reporta desde ${lastReportLocal}`}
        title={`Caja ${deviceName} sin sincronizar`}
    >
        <HeroMetric
            label="Sin reportar"
            value={silentFor}
            tone={palette.negative}
            caption={`Último reporte: ${lastReportLocal}`}
        />
        <MetricRow metrics={countMetrics(pendingSalesCount, blockedSalesCount)} />
        <ReportSection title="Qué significa">
            <Text style={{ ...text.label, lineHeight: '18px' }}>
                La caja tenía un turno abierto en su último reporte y desde entonces no se
                ha comunicado. Puede estar apagada, sin red o con la aplicación cerrada: lo
                que venda mientras tanto no aparece en reportes hasta que vuelva a
                sincronizar. Las cifras de arriba son las de su último reporte.
            </Text>
        </ReportSection>
        <Text style={text.note}>
            Este aviso se manda una sola vez por caída: no se repite hasta que la caja
            vuelva a reportar.
        </Text>
    </Layout>
);

const REASON_TEXT: Record<BlockedSalesAlertReason, string> = {
    appeared: 'Aparecieron ventas bloqueadas (antes no había ninguna).',
    increased: 'Aumentaron las ventas bloqueadas respecto al reporte anterior.',
};

export interface PosBlockedSalesAlertEmailProps {
    deviceName: string;
    /** Hora local del reporte que disparó la alerta. */
    lastReportLocal: string;
    reason: BlockedSalesAlertReason;
    previousCount: number;
    pendingSalesCount: number;
    blockedSales: Array<{
        localId: string;
        folio: string;
        total: number;
        pushError: string;
        isNew: boolean;
    }>;
}

export const PosBlockedSalesAlertEmail = ({
    deviceName,
    lastReportLocal,
    reason,
    previousCount,
    pendingSalesCount,
    blockedSales,
}: PosBlockedSalesAlertEmailProps) => {
    // Las nuevas primero: son el motivo del correo.
    const ordered = [...blockedSales].sort((a, b) => Number(b.isNew) - Number(a.isNew));
    const shown = ordered.slice(0, MAX_ROWS);
    const rest = ordered.length - shown.length;
    const blockedTotal = blockedSales.reduce((sum, sale) => sum + sale.total, 0);

    return (
        <Layout
            preview={`${REASON_TEXT[reason]} Caja ${deviceName}: ${blockedSales.length} ` +
                'ventas bloqueadas'}
            title={`Caja ${deviceName}: ventas bloqueadas`}
        >
            <HeroMetric
                label="Ventas bloqueadas"
                value={String(blockedSales.length)}
                tone={palette.negative}
                caption={`${formatCurrency(blockedTotal)} cobrados sin subir · ` +
                    `antes ${previousCount}`}
            />
            <MetricRow metrics={countMetrics(pendingSalesCount, blockedSales.length)} />
            <Text style={{ ...text.label, margin: '14px 0 0' }}>
                {`${REASON_TEXT[reason]} Reporte de las ${lastReportLocal}.`}
            </Text>
            <ReportSection title="Ventas bloqueadas">
                <DataTable
                    rows={shown.map((sale) => ({
                        key: sale.localId,
                        label: sale.isNew ? `${sale.folio} · nueva` : sale.folio,
                        sublabel: sale.pushError,
                        value: formatCurrency(sale.total),
                    }))}
                />
                {rest > 0 ? (
                    <Text style={{ ...text.label, margin: '8px 0 0' }}>
                        {`y ${rest} ventas más`}
                    </Text>
                ) : null}
            </ReportSection>
            <Text style={text.note}>
                Este aviso solo se manda cuando las ventas bloqueadas aparecen o aumentan; si
                siguen igual en los siguientes reportes no se repite.
            </Text>
        </Layout>
    );
};

export interface PosStockDriftAlertEmailProps {
    deviceName: string;
    /** Hora local de la comparación de hoy. */
    checkedAtLocal: string;
    /** Productos comparados hoy. */
    compared: number;
    /** Divergentes hoy (incluye los que no se repitieron). */
    divergingToday: number;
    /** Los que divergieron ayer y hoy, con las cifras de hoy. */
    repeated: Array<{
        productId: string;
        name: string | null;
        local: number;
        server: number | null;
    }>;
}

const stockDelta = (item: { local: number; server: number | null }): string => {
    if (item.server === null) {
        return 'no existe en el servidor';
    }
    const delta = item.local - item.server;
    return `${delta > 0 ? '+' : ''}${delta} en la caja`;
};

/**
 * Stock de la caja distinto al del servidor en el mismo producto dos días
 * seguidos (SPEC 67). Un día suelto no llega aquí: puede ser una venta en
 * vuelo. Dos días ya es un inventario que la caja y el panel cuentan distinto.
 */
export const PosStockDriftAlertEmail = ({
    deviceName,
    checkedAtLocal,
    compared,
    divergingToday,
    repeated,
}: PosStockDriftAlertEmailProps) => {
    const shown = repeated.slice(0, MAX_ROWS);
    const rest = repeated.length - shown.length;
    return (
        <Layout
            preview={`Caja ${deviceName}: ${repeated.length} productos con stock distinto al ` +
                'servidor dos días seguidos'}
            title={`Caja ${deviceName}: stock distinto al servidor`}
        >
            <HeroMetric
                label="Productos con diferencia dos días seguidos"
                value={String(repeated.length)}
                tone={palette.negative}
                caption={`Hoy: ${divergingToday} de ${compared} comparados · ${checkedAtLocal}`}
            />
            <ReportSection title="Productos">
                <DataTable
                    rows={shown.map((item) => ({
                        key: item.productId,
                        label: item.name ?? item.productId,
                        sublabel: stockDelta(item),
                        value: `Caja ${item.local} · Servidor ${item.server ?? '—'}`,
                    }))}
                />
                {rest > 0 ? (
                    <Text style={{ ...text.label, margin: '8px 0 0' }}>
                        {`y ${rest} productos más`}
                    </Text>
                ) : null}
            </ReportSection>
            <ReportSection title="Qué hacer">
                <Text style={{ ...text.label, lineHeight: '18px' }}>
                    La caja solo compara productos sin cambios pendientes de subir, así que la
                    diferencia no es una venta en camino. Cuenta físicamente esos productos y
                    corrige el inventario; nada se ajusta solo. El detalle está en la ficha de
                    la caja en «Salud de cajas».
                </Text>
            </ReportSection>
        </Layout>
    );
};
