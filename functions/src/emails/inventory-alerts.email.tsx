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
import { ExpiringBatchAlert, InventoryAlerts, StockAlert } from '../types';
import {
    DataRow,
    DataTable,
    EmptyState,
    HeroMetric,
    MetricRow,
    ReportSection,
    palette,
    text,
} from './components/report-ui';

/**
 * Alertas de inventario.
 *
 * El correo contesta **una** pregunta: qué hay que hacer hoy. Todo lo que no
 * sea eso es contexto, y va como cifra, no como lista.
 *
 * La separación entre faltante (`outOfStock`, con mínimo definido) y ficha de
 * catálogo en cero (`unstocked`) la hace el servicio; aquí solo se refleja:
 * lo primero se lista como pedido, lo segundo es una cifra y una nota. Ver
 * `inventory-alerts.service.ts` para por qué existe esa división.
 */

/**
 * Renglones por sección. Ocho porque el correo se lee en el teléfono al abrir
 * la farmacia: lo que no cabe en una pantalla no se lee, y el resto está en el
 * panel. Se prefiere ordenar bien ocho que listar mal cuarenta.
 */
const MAX_ROWS = 8;

/** Unidades que faltan para volver al mínimo: es lo que hay que pedir. */
const shortfall = (item: StockAlert): number =>
    Math.max(0, item.minStock - item.totalStock);

const units = (quantity: number): string => `${quantity} u`;

/**
 * Corta la lista y devuelve cuántas quedaron fuera.
 *
 * Antes, `Agotados` cortaba en 15 sin decirlo: el lector creía estar viendo
 * todo. Un truncado silencioso es peor que uno explícito.
 */
const trim = <T,>(items: T[]): { shown: T[]; rest: number } => ({
    shown: items.slice(0, MAX_ROWS),
    rest: Math.max(0, items.length - MAX_ROWS),
});

const Rest = ({ count, noun }: { count: number; noun: string }) =>
    (count > 0
        ? <Text style={{ ...text.label, margin: '8px 0 0' }}>{`y ${count} ${noun} más`}</Text>
        : null);

const batchRows = (items: ExpiringBatchAlert[]): DataRow[] => items.map((item) => ({
    key: item.batchId,
    label: item.productName,
    sublabel: `Lote ${item.lotNumber} · ${item.daysToExpiry <= 0
        ? `venció hace ${Math.abs(item.daysToExpiry)} d`
        : `caduca en ${item.daysToExpiry} d`}`,
    value: units(item.quantity),
}));

export const InventoryAlertsEmail = ({ alerts }: { alerts: InventoryAlerts }) => {
    const { totals } = alerts;

    // `outOfStock` ya llega ordenado por mínimo descendente desde el servicio.
    // Aquí solo se ordena lo que depende de una cuenta de presentación: cuánto
    // falta para volver al mínimo.
    const bajoMinimo = [...alerts.lowStock].sort((a, b) => shortfall(b) - shortfall(a));

    const porReponer = totals.outOfStockProducts + totals.lowStockProducts;
    const agotados = trim(alerts.outOfStock);
    const bajos = trim(bajoMinimo);
    const vencidos = trim(alerts.expired);

    return (
        <Html lang="es">
            <Head />
            <Preview>
                {`${porReponer} por reponer · ${totals.expiredBatches} lotes vencidos · ` +
                    `${totals.expiringBatches} por caducar`}
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
                    <Heading style={text.title}>Alertas de inventario</Heading>

                    {/*
                      * Una sola cifra grande: cuántos productos hay que pedir. Es la
                      * decisión del día; el resto del correo la sustenta.
                      */}
                    <HeroMetric
                        label="Productos por reponer"
                        value={String(porReponer)}
                        tone={porReponer > 0 ? palette.negative : palette.positive}
                        caption={`${totals.outOfStockProducts} agotados · ` +
                            `${totals.lowStockProducts} bajo el mínimo`}
                    />

                    <MetricRow
                        metrics={[
                            {
                                label: 'Lotes vencidos',
                                value: `${totals.expiredBatches} · ${units(totals.expiredUnits)}`,
                                tone: totals.expiredBatches > 0
                                    ? palette.negative
                                    : palette.muted,
                            },
                            {
                                label: 'Lotes por caducar',
                                value: `${totals.expiringBatches} · ${units(totals.expiringUnits)}`,
                                tone: totals.expiringBatches > 0
                                    ? palette.expense
                                    : palette.muted,
                            },
                            {
                                label: 'Sin mínimo definido',
                                value: String(totals.unstockedProducts),
                                tone: palette.muted,
                            },
                        ]}
                    />

                    {/*
                      * Vencido primero: es mercancía que ya no se puede vender y
                      * que sigue en el anaquel. Retirarla es lo único que no puede
                      * esperar al pedido de mañana.
                      */}
                    {alerts.expired.length > 0 && (
                        <ReportSection title="Retirar del anaquel — vencidos con existencia">
                            <DataTable rows={batchRows(vencidos.shown)} />
                            <Rest count={vencidos.rest} noun="lotes" />
                        </ReportSection>
                    )}

                    <ReportSection title="Pedir — agotados con mínimo definido">
                        {alerts.outOfStock.length > 0 ? (
                            <>
                                <DataTable
                                    rows={agotados.shown.map((item) => ({
                                        key: item.productId,
                                        label: item.productName,
                                        sublabel: item.sku,
                                        value: `pedir ${units(item.minStock)}`,
                                    }))}
                                />
                                <Rest count={agotados.rest} noun="productos" />
                            </>
                        ) : (
                            <EmptyState>
                                Ningún producto con mínimo definido está agotado.
                            </EmptyState>
                        )}
                    </ReportSection>

                    {bajoMinimo.length > 0 && (
                        <ReportSection title="Por debajo del mínimo">
                            <DataTable
                                rows={bajos.shown.map((item) => ({
                                    key: item.productId,
                                    label: item.productName,
                                    // El mínimo va en el subtítulo para que la
                                    // columna derecha diga una sola cosa: cuánto pedir.
                                    sublabel: `${item.totalStock} u en piso · ` +
                                        `mínimo ${item.minStock}`,
                                    value: `pedir ${units(shortfall(item))}`,
                                }))}
                            />
                            <Rest count={bajos.rest} noun="productos" />
                        </ReportSection>
                    )}

                    {alerts.expiring.map((window) => {
                        if (window.items.length === 0) {
                            return null;
                        }
                        const { shown, rest } = trim(window.items);
                        return (
                            <ReportSection
                                key={window.windowDays}
                                title={`Caducan en ${window.windowDays} días`}
                            >
                                <DataTable rows={batchRows(shown)} />
                                <Rest count={rest} noun="lotes" />
                            </ReportSection>
                        );
                    })}

                    <Hr style={{ borderColor: palette.line, margin: '26px 0 0' }} />

                    {/*
                      * La cifra de "sin mínimo" no es un pendiente de compra: es
                      * catálogo por depurar. Se explica una vez, al final, para que
                      * nadie la lea como faltantes.
                      */}
                    {totals.unstockedProducts > 0 && (
                        <Text style={text.note}>
                            {`${totals.unstockedProducts} productos están en cero pero no tienen ` +
                                'stock mínimo definido, así que no se listan como pedido. ' +
                                'Si alguno debe reponerse, asígnale un mínimo en el ' +
                                'catálogo; si ya no se vende, dalo de baja.'}
                        </Text>
                    )}
                    <Text style={text.note}>
                        Generado automáticamente por el backend de Farmacia JyV.
                    </Text>
                </Container>
            </Body>
        </Html>
    );
};

export default InventoryAlertsEmail;
