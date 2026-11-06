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
import { formatCurrency } from '../utils/currency';
import {
    DataTable,
    HeroMetric,
    ReportSection,
    palette,
    text,
} from './components/report-ui';

/**
 * Aviso de venta no conciliada (SPEC 53): una caja cobró una venta que el
 * servidor no pudo registrar. El dinero está en el cajón pero fuera de reportes
 * y del corte hasta que alguien la resuelva en el panel, así que el correo
 * contesta qué caja, cuánto, quién y por qué, en ese orden.
 */
export interface UnreconciledSaleAlertEmailProps {
    deviceLabel: string;
    total: number;
    cashierLabel: string;
    /** Hora real del cobro (o del alta, si la caja no la mandó), en hora local. */
    occurredLocal: string;
    localFolio: string | null;
    reason: string;
}

export const unreconciledSaleSubject = (total: number, deviceLabel: string): string =>
    `Venta no conciliada: ${formatCurrency(total)} en ${deviceLabel}`;

export const UnreconciledSaleAlertEmail = ({
    deviceLabel,
    total,
    cashierLabel,
    occurredLocal,
    localFolio,
    reason,
}: UnreconciledSaleAlertEmailProps) => (
    <Html lang="es">
        <Head />
        <Preview>{`${unreconciledSaleSubject(total, deviceLabel)} · ${reason}`}</Preview>
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
                <Heading style={text.title}>{`Venta no conciliada en ${deviceLabel}`}</Heading>
                <HeroMetric
                    label="Cobrado sin registrar"
                    value={formatCurrency(total)}
                    tone={palette.negative}
                    caption={`Cobrada el ${occurredLocal}`}
                />
                <ReportSection title="Detalle">
                    <DataTable
                        rows={[
                            { key: 'device', label: 'Caja', value: deviceLabel },
                            { key: 'cashier', label: 'Cajero', value: cashierLabel },
                            ...(localFolio
                                ? [{ key: 'folio', label: 'Folio del ticket', value: localFolio }]
                                : []),
                        ]}
                    />
                </ReportSection>
                <ReportSection title="Por qué no se registró">
                    <Text style={{ ...text.label, lineHeight: '18px' }}>{reason}</Text>
                </ReportSection>
                <Hr style={{ borderColor: palette.line, margin: '26px 0 0' }} />
                <Text style={text.note}>
                    El dinero ya entró al cajón, pero la venta no aparece en reportes ni en el
                    corte hasta resolverla. Regístrala o descártala con motivo en «Ventas no
                    conciliadas» del panel.
                </Text>
            </Container>
        </Body>
    </Html>
);
