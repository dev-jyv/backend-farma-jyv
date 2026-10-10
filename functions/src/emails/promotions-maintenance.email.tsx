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
import { Promotion, PromotionPerformance } from '../types';
import { formatCurrency } from '../utils/currency';
import {
    DataTable,
    HeroMetric,
    MetricRow,
    ReportSection,
    palette,
    text,
} from './components/report-ui';
import { describePromotionRule, formatPromotionDate } from './components/promotion-text';

/**
 * Resumen diario de promociones: las que cerraron (con cómo les fue) y las que
 * terminan en las próximas 24 horas.
 *
 * Contesta dos preguntas: ¿valió la pena la que acabó? —para decidir si se
 * repite— y ¿hay que extender alguna antes de que se apague sola? Por eso el
 * desempeño va como comparación contra antes de la promo, no como lista de
 * ventas: "vendió 40 piezas" no dice nada sin saber que antes se vendían 10.
 */

export interface PromotionsMaintenanceEmailProps {
    closed: Array<{ promotion: Promotion; performance: PromotionPerformance | null }>;
    endingSoon: Promotion[];
}

const liftLabel = (lift: number | null): string =>
    lift === null ? 'sin ventas previas' : `${lift > 0 ? '+' : ''}${lift.toFixed(1)} %`;

const liftTone = (lift: number | null): string =>
    lift === null ? palette.muted : lift >= 0 ? palette.positive : palette.negative;

const ClosedPromotionBlock = ({
    promotion,
    performance,
}: PromotionsMaintenanceEmailProps['closed'][number]) => (
    <ReportSection title={`${promotion.name} · ${describePromotionRule(promotion.rule)}`}>
        <Text style={{ ...text.label, margin: '0 0 4px' }}>
            {`${formatPromotionDate(promotion.startsAt.toDate())} → ` +
                (promotion.endsAt ? formatPromotionDate(promotion.endsAt.toDate()) : 'sin fin')}
        </Text>
        {performance ? (
            <>
                <MetricRow
                    metrics={[
                        {
                            label: 'Piezas / día vs antes',
                            value: `${performance.unitsPerDayDuring} vs ` +
                                `${performance.baseline.unitsPerDay}`,
                        },
                        {
                            label: 'Variación',
                            value: liftLabel(performance.liftPercent),
                            tone: liftTone(performance.liftPercent),
                        },
                        {
                            // El descuento es lo que costó la promo; la utilidad
                            // dice si aun así dejó dinero.
                            label: 'Descontado · utilidad',
                            value: `${formatCurrency(performance.discountTotal)} · ` +
                                (performance.grossProfit === null
                                    ? 'sin costo'
                                    : formatCurrency(performance.grossProfit)),
                        },
                    ]}
                />
                <DataTable
                    rows={[
                        {
                            key: 'ventas',
                            label: `${performance.salesCount} ventas · ` +
                                `${performance.unitsSold} piezas`,
                            sublabel: `${performance.daysActive} días activa · base de ` +
                                `${performance.baseline.days} días previos`,
                            value: formatCurrency(performance.netRevenue),
                        },
                        ...performance.byProduct.slice(0, 5).map((product) => ({
                            key: product.productId,
                            label: product.productName,
                            sublabel: `${product.unitsSold} u · ` +
                                `-${formatCurrency(product.discountTotal)}`,
                            value: formatCurrency(product.netRevenue),
                        })),
                    ]}
                />
            </>
        ) : (
            <Text style={text.label}>
                No se pudo calcular su desempeño; consúltalo en el admin.
            </Text>
        )}
    </ReportSection>
);

export const PromotionsMaintenanceEmail = ({
    closed,
    endingSoon,
}: PromotionsMaintenanceEmailProps) => (
    <Html lang="es">
        <Head />
        <Preview>
            {`${closed.length} promociones cerradas · ${endingSoon.length} terminan en 24 h`}
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
                    borderRadius: '10px',
                    margin: '0 auto',
                    maxWidth: '600px',
                    padding: '32px',
                }}
            >
                <Text style={text.brand}>Farmacia JyV</Text>
                <Heading style={text.title}>Promociones del día</Heading>

                <HeroMetric
                    label="Terminan en las próximas 24 horas"
                    value={String(endingSoon.length)}
                    tone={endingSoon.length > 0 ? palette.expense : palette.muted}
                    caption={`${closed.length} cerradas hoy por fin de vigencia`}
                />

                {/*
                  * Por terminar primero: es lo único accionable hoy (extenderla o
                  * dejarla ir). Las cerradas ya pasaron; son para decidir la próxima.
                  */}
                {endingSoon.length > 0 && (
                    <ReportSection title="Por terminar — extiéndelas en el admin si conviene">
                        <DataTable
                            rows={endingSoon.map((promotion) => ({
                                key: promotion.id,
                                label: promotion.name,
                                sublabel: `${describePromotionRule(promotion.rule)} · ` +
                                    `${promotion.productIds.length} producto(s)`,
                                value: promotion.endsAt
                                    ? formatPromotionDate(promotion.endsAt.toDate())
                                    : '—',
                            }))}
                        />
                    </ReportSection>
                )}

                {closed.map((entry) => (
                    <ClosedPromotionBlock key={entry.promotion.id} {...entry} />
                ))}

                <Hr style={{ borderColor: palette.line, margin: '26px 0 0' }} />
                <Text style={text.note}>
                    La variación compara las piezas vendidas por día durante la promoción
                    contra el mismo número de días justo antes (hasta 90). Una promoción
                    cerrada se puede volver a crear desde el admin con la misma regla.
                </Text>
                <Text style={text.note}>
                    Generado automáticamente por el backend de Farmacia JyV.
                </Text>
            </Container>
        </Body>
    </Html>
);

export default PromotionsMaintenanceEmail;
