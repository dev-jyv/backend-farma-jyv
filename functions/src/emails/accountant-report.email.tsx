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
import { DataTable, ReportSection, palette, text } from './components/report-ui';

/**
 * Correo mensual del contador (SPEC 45). El trabajo lo hacen los adjuntos; el
 * cuerpo solo responde "¿qué me mandaron y de cuánto es?" para que el contador
 * sepa sin abrir nada si el mes cuadra con lo que esperaba.
 */

export interface AccountantReportSummary {
    label: string;
    /** Ventas o facturas del periodo. */
    count: number;
    amount: number;
}

export interface AccountantReportAttachment {
    filename: string;
    label: string;
}

export interface AccountantReportEmailProps {
    recipientName?: string;
    /** "octubre de 2026". */
    periodLabel: string;
    summary: AccountantReportSummary[];
    attachments: AccountantReportAttachment[];
}

const countLabel = (count: number): string =>
    count === 1 ? '1 operación' : `${count} operaciones`;

export const AccountantReportEmail = ({
    recipientName,
    periodLabel,
    summary,
    attachments,
}: AccountantReportEmailProps) => (
    <Html lang="es">
        <Head />
        <Preview>{`Ventas y compras de ${periodLabel}: ${attachments.length} archivos`}</Preview>
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
                <Heading style={text.title}>Reportes para contabilidad</Heading>
                <Text style={text.period}>{periodLabel}</Text>
                {recipientName ? (
                    <Text style={{ ...text.label, margin: '16px 0 0', fontSize: '13px' }}>
                        {`Hola, ${recipientName}. Te compartimos las ventas y compras del mes.`}
                    </Text>
                ) : null}

                <ReportSection title="Totales del mes">
                    <DataTable
                        rows={summary.map((item) => ({
                            key: item.label,
                            label: item.label,
                            sublabel: countLabel(item.count),
                            value: formatCurrency(item.amount),
                        }))}
                    />
                </ReportSection>

                <ReportSection title="Archivos adjuntos">
                    <DataTable
                        rows={attachments.map((attachment) => ({
                            key: attachment.filename,
                            label: attachment.filename,
                            sublabel: attachment.label,
                            value: attachment.filename.endsWith('.pdf') ? 'PDF' : 'Excel',
                        }))}
                    />
                </ReportSection>

                <Hr style={{ borderColor: palette.line, margin: '26px 0 0' }} />
                <Text style={text.note}>
                    Las ventas anuladas no se incluyen. Una venta con productos y servicios
                    aparece en farmacia y en consultorio con el importe de su parte. Para otro
                    periodo, entra al panel en «Reportes para contabilidad».
                </Text>
            </Container>
        </Body>
    </Html>
);
