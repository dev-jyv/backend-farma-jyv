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
 * Aviso de promociones dadas de baja solas porque un cambio de precio las dejó
 * sin sentido (ver `retirePromotionsBrokenByPrice`).
 *
 * Sin este correo la promo simplemente desaparecía del mostrador y nadie sabía
 * por qué hasta revisar la bitácora. Dice qué se apagó, por qué, y qué hacer:
 * crear otra con una regla que tenga sentido al precio nuevo.
 */

export interface PromotionsRetiredEmailProps {
    product: { name: string; salePrice: number };
    retired: Array<{ id: string; name: string; ruleText: string; problem: string }>;
}

export const PromotionsRetiredEmail = ({ product, retired }: PromotionsRetiredEmailProps) => (
    <Html lang="es">
        <Head />
        <Preview>
            {`${retired.length === 1 ? 'Promoción dada de baja' : 'Promociones dadas de baja'}` +
                ` por el precio nuevo de ${product.name}`}
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
                <Heading style={text.title}>Promoción dada de baja por cambio de precio</Heading>
                <Text style={text.period}>
                    {`${product.name} ahora cuesta ${formatCurrency(product.salePrice)}`}
                </Text>

                <ReportSection title="Qué se dio de baja y por qué">
                    <DataTable
                        rows={retired.map((entry) => ({
                            key: entry.id,
                            label: entry.name,
                            sublabel: entry.problem,
                            value: entry.ruleText,
                        }))}
                    />
                </ReportSection>

                <Hr style={{ borderColor: palette.line, margin: '26px 0 0' }} />
                <Text style={text.note}>
                    La regla de una promoción no se puede editar, así que con el precio nuevo
                    ya no daba descuento o cobraba menos por llevar más piezas. Si la
                    promoción sigue haciendo falta, créala de nuevo en el admin con una regla
                    acorde al precio actual. Las ventas ya cobradas con ella no cambian.
                </Text>
                <Text style={text.note}>
                    Generado automáticamente por el backend de Farmacia JyV.
                </Text>
            </Container>
        </Body>
    </Html>
);

export default PromotionsRetiredEmail;
