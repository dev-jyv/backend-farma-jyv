import { Column, Row, Section, Text } from '@react-email/components';
import { ReactNode } from 'react';
import { formatCurrency } from '../../utils/currency';

/**
 * Piezas de UI compartidas por el correo diario y el mensual.
 *
 * Restricciones de correo que explican el estilo: **todo va en estilos inline**
 * (Gmail borra `<style>`), el layout se arma con tablas —`Row`/`Column` de React
 * Email— porque flexbox y grid no son fiables en Outlook, y las barras de
 * proporción son celdas con `width` en porcentaje, no `<progress>` ni SVG.
 */

export const palette = {
    ink: '#111827',
    muted: '#6b7280',
    line: '#e5e7eb',
    surface: '#ffffff',
    canvas: '#f4f7f5',
    /** Farmacia. */
    pharmacy: '#166534',
    /** Consultorio. */
    services: '#1d4ed8',
    expense: '#b45309',
    positive: '#166534',
    negative: '#b91c1c',
};

export const text = {
    brand: {
        color: palette.pharmacy,
        fontSize: '12px',
        fontWeight: 700 as const,
        letterSpacing: '1.2px',
        margin: 0,
        textTransform: 'uppercase' as const,
    },
    title: { color: palette.ink, fontSize: '24px', margin: '4px 0 0', lineHeight: '30px' },
    period: {
        color: palette.muted,
        fontSize: '14px',
        margin: '2px 0 0',
        textTransform: 'capitalize' as const,
    },
    sectionTitle: {
        color: palette.ink,
        fontSize: '11px',
        fontWeight: 700 as const,
        letterSpacing: '0.8px',
        margin: '0 0 10px',
        textTransform: 'uppercase' as const,
    },
    label: { color: palette.muted, fontSize: '12px', margin: 0 },
    value: { color: palette.ink, fontSize: '13px', margin: 0, textAlign: 'right' as const },
    note: { color: palette.muted, fontSize: '12px', margin: '18px 0 0', lineHeight: '17px' },
};

const cell = {
    padding: '7px 0',
    borderBottom: `1px solid ${palette.line}`,
};

/** Bloque con separación consistente entre secciones. */
export const ReportSection = ({
    title,
    children,
}: { title: string; children: ReactNode }) => (
    <Section style={{ margin: '26px 0 0' }}>
        <Text style={text.sectionTitle}>{title}</Text>
        {children}
    </Section>
);

/**
 * Cifra principal del reporte. Se separa del resto de KPI porque en un correo el
 * lector decide en dos segundos si abre el PDF: una sola cifra grande gana.
 */
export const HeroMetric = ({
    label,
    value,
    caption,
    tone = palette.ink,
}: {
    label: string;
    value: string;
    caption?: string;
    tone?: string;
}) => (
    <Section
        style={{
            backgroundColor: '#f8fafc',
            border: `1px solid ${palette.line}`,
            borderRadius: '10px',
            padding: '18px 20px',
            margin: '20px 0 0',
        }}
    >
        <Text style={{ ...text.label, fontSize: '12px' }}>{label}</Text>
        <Text
            style={{
                color: tone,
                fontSize: '32px',
                fontWeight: 700 as const,
                lineHeight: '38px',
                margin: '2px 0 0',
            }}
        >
            {value}
        </Text>
        {caption ? (
            <Text style={{ ...text.label, margin: '4px 0 0' }}>{caption}</Text>
        ) : null}
    </Section>
);

export interface Metric {
    label: string;
    value: string;
    tone?: string;
}

/** Fila de 2 a 3 KPI secundarios. Más de tres no caben legibles en móvil. */
export const MetricRow = ({ metrics }: { metrics: Metric[] }) => (
    <Row style={{ margin: '14px 0 0' }}>
        {metrics.map((metric) => (
            <Column key={metric.label} style={{ verticalAlign: 'top', paddingRight: '10px' }}>
                <Text
                    style={{
                        color: metric.tone ?? palette.ink,
                        fontSize: '17px',
                        fontWeight: 700 as const,
                        margin: 0,
                    }}
                >
                    {metric.value}
                </Text>
                <Text style={{ ...text.label, margin: '2px 0 0' }}>{metric.label}</Text>
            </Column>
        ))}
    </Row>
);

/** Barra de proporción de una sola dimensión (0-100). */
export const ShareBar = ({
    percent,
    color,
    height = '6px',
}: { percent: number; color: string; height?: string }) => {
    const width = Math.max(0, Math.min(100, percent));
    return (
        <table
            role="presentation"
            cellPadding={0}
            cellSpacing={0}
            style={{
                width: '100%',
                backgroundColor: palette.line,
                borderRadius: '999px',
                margin: '5px 0 0',
            }}
        >
            <tbody>
                <tr>
                    <td
                        style={{
                            width: `${width}%`,
                            height,
                            backgroundColor: color,
                            borderRadius: '999px',
                            fontSize: 0,
                            lineHeight: 0,
                        }}
                    >
                        &nbsp;
                    </td>
                    <td style={{ fontSize: 0, lineHeight: 0 }}>&nbsp;</td>
                </tr>
            </tbody>
        </table>
    );
};

/** Tarjeta de rama del negocio: farmacia o consultorio. */
export const BranchCard = ({
    label,
    total,
    share,
    caption,
    color,
}: {
    label: string;
    total: number;
    share: number;
    caption: string;
    color: string;
}) => (
    <Column style={{ verticalAlign: 'top', width: '50%', paddingRight: '8px' }}>
        <table
            role="presentation"
            cellPadding={0}
            cellSpacing={0}
            style={{
                width: '100%',
                border: `1px solid ${palette.line}`,
                borderRadius: '10px',
            }}
        >
            <tbody>
                <tr>
                    <td style={{ padding: '14px 14px 16px' }}>
                        <Text
                            style={{
                                color,
                                fontSize: '11px',
                                fontWeight: 700 as const,
                                letterSpacing: '0.6px',
                                margin: 0,
                                textTransform: 'uppercase' as const,
                            }}
                        >
                            {label}
                        </Text>
                        <Text
                            style={{
                                color: palette.ink,
                                fontSize: '20px',
                                fontWeight: 700 as const,
                                margin: '4px 0 0',
                            }}
                        >
                            {formatCurrency(total)}
                        </Text>
                        <Text style={{ ...text.label, margin: '2px 0 0' }}>
                            {`${share.toFixed(1)} % del total`}
                        </Text>
                        <ShareBar percent={share} color={color} />
                        <Text style={{ ...text.label, margin: '6px 0 0' }}>{caption}</Text>
                    </td>
                </tr>
            </tbody>
        </table>
    </Column>
);

export interface DataRow {
    key: string;
    label: string;
    sublabel?: string | null;
    value: string;
    /** 0-100: dibuja una barra proporcional bajo la etiqueta. */
    percent?: number;
    color?: string;
    /** Prefijo de posición para los rankings ("1", "2", ...). */
    rank?: number;
}

/** Tabla de dos columnas con barra opcional; base de todos los desgloses. */
export const DataTable = ({ rows }: { rows: DataRow[] }) => (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ width: '100%' }}>
        <tbody>
            {rows.map((row) => (
                <tr key={row.key}>
                    <td style={{ ...cell, paddingRight: '12px' }}>
                        <Text style={{ color: palette.ink, fontSize: '13px', margin: 0 }}>
                            {row.rank !== undefined ? (
                                <span style={{ color: palette.muted }}>{`${row.rank}. `}</span>
                            ) : null}
                            {row.label}
                        </Text>
                        {row.sublabel ? (
                            <Text style={{ ...text.label, margin: '1px 0 0' }}>
                                {row.sublabel}
                            </Text>
                        ) : null}
                        {row.percent !== undefined ? (
                            <ShareBar
                                percent={row.percent}
                                color={row.color ?? palette.pharmacy}
                                height="4px"
                            />
                        ) : null}
                    </td>
                    <td style={{ ...cell, width: '32%' }}>
                        <Text style={{ ...text.value, fontWeight: 600 as const }}>
                            {row.value}
                        </Text>
                    </td>
                </tr>
            ))}
        </tbody>
    </table>
);

/** Renglón de cierre de una tabla (total), sin borde inferior. */
export const TotalRow = ({
    label,
    value,
    tone = palette.ink,
}: { label: string; value: string; tone?: string }) => (
    <Row style={{ margin: '8px 0 0' }}>
        <Column>
            <Text
                style={{
                    color: palette.ink,
                    fontSize: '13px',
                    fontWeight: 700 as const,
                    margin: 0,
                }}
            >
                {label}
            </Text>
        </Column>
        <Column style={{ width: '32%' }}>
            <Text style={{ ...text.value, color: tone, fontWeight: 700 as const }}>
                {value}
            </Text>
        </Column>
    </Row>
);

export const EmptyState = ({ children }: { children: ReactNode }) => (
    <Text style={{ ...text.label, fontStyle: 'italic' as const }}>{children}</Text>
);
