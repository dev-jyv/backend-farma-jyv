import * as pharmacyServicesRepo from '../../../repositories/pharmacy-services.repository';
import * as productsRepo from '../../../repositories/products.repository';
import * as returnsRepo from '../../../repositories/sale-returns.repository';
import * as salesRepo from '../../../repositories/sales.repository';
import {
    Sale,
    SaleItemTaxes,
    SaleReturn,
    ServiceTaxMode,
    isSaleServiceItem,
} from '../../../types';
import { formatCurrency } from '../../../utils/currency';
import { fromCents, toCents } from '../../../utils/taxes';
import { getMaxReportSpanDays } from '../../../utils/report-range';
import { ReportDefinition, ReportRow, sumColumn } from '../report-definition';
import { resolveReportPeriod } from '../period';

/**
 * Régimen de IVA de un renglón. La venta guarda la **tasa** (`ivaRate`), no el
 * régimen: tasa 0 % y exento se guardan igual (0), pero en la declaración son
 * columnas distintas —la tasa 0 % da derecho a acreditar, el exento no—, así
 * que el 0 se separa con la ficha del producto o servicio.
 */
export type IvaTreatment = 'standard' | 'zero' | 'exempt' | 'none';

const TREATMENT_ORDER: Record<IvaTreatment, number> = {
    standard: 0,
    zero: 1,
    exempt: 2,
    none: 3,
};

/** Lo que hace falta de la ficha para separar tasa 0 % de exento. */
export interface TaxCatalog {
    products: ReadonlyMap<string, {
        name: string;
        sku?: string;
        hasIva: boolean;
        hasIvaZero: boolean;
    }>;
    services: ReadonlyMap<string, { code: string; taxMode: ServiceTaxMode }>;
}

interface Line {
    concept: string;
    code: string;
    treatment: IvaTreatment;
    ivaRate: number;
    quantity: number;
    base: number;
    ieps: number;
    iva: number;
    total: number;
}

/**
 * Tasa 0 o exento de un producto con IVA en cero. Sin "IVA" ni "IVA 0" en la
 * ficha es exento: la misma convención que `sales.service` usa para el servicio
 * `exempt` (`hasIva: false, hasIvaZero: false`). Si la ficha ya no existe, o
 * hoy dice 16 % cuando se vendió en cero, no hay forma de saber cuál fue y se
 * reporta en tasa 0 %, que es lo que corresponde a un medicamento.
 */
const productZeroTreatment = (
    product: { hasIva: boolean; hasIvaZero: boolean } | undefined,
): IvaTreatment => (product && !product.hasIva && !product.hasIvaZero ? 'exempt' : 'zero');

const treatmentOf = (taxes: SaleItemTaxes | undefined, zero: () => IvaTreatment): IvaTreatment => {
    if (!taxes) {
        return 'none';
    }
    return taxes.ivaRate > 0 ? 'standard' : zero();
};

const rateLabel = (line: Line): string => {
    switch (line.treatment) {
    case 'standard':
        return `${Math.round(line.ivaRate * 100)} %`;
    case 'zero':
        return '0 %';
    case 'exempt':
        return 'Exento';
    default:
        return 'Sin desglose';
    }
};

/**
 * Un renglón por concepto y régimen de IVA, en centavos. Lo devuelto en el
 * periodo se resta con las tasas guardadas en la devolución (las de la venta),
 * igual que el reporte `impuestos`, para que los dos cuadren.
 */
export const buildTaxByProductRows = (
    sales: readonly Sale[],
    returns: readonly SaleReturn[],
    catalog: TaxCatalog,
): { rows: ReportRow[]; withoutBreakdown: number; exemptProducts: number } => {
    const lines = new Map<string, Line>();
    const exemptProductIds = new Set<string>();

    const lineFor = (
        key: string,
        seed: () => Omit<Line, 'quantity' | 'base' | 'ieps' | 'iva' | 'total'>,
    ): Line => {
        let line = lines.get(key);
        if (!line) {
            line = { ...seed(), quantity: 0, base: 0, ieps: 0, iva: 0, total: 0 };
            lines.set(key, line);
        }
        return line;
    };

    const productSeed = (productId: string, storedName: string) => {
        const product = catalog.products.get(productId);
        return { concept: product?.name ?? storedName, code: product?.sku ?? '' };
    };

    const productTreatment = (productId: string, taxes: SaleItemTaxes | undefined) =>
        treatmentOf(taxes, () => {
            const treatment = productZeroTreatment(catalog.products.get(productId));
            if (treatment === 'exempt') {
                exemptProductIds.add(productId);
            }
            return treatment;
        });

    /** `sign` es 1 para lo vendido y -1 para lo devuelto. */
    const post = (
        line: Line,
        sign: 1 | -1,
        quantity: number,
        taxes: SaleItemTaxes | undefined,
        gross: number,
    ): void => {
        line.quantity += sign * quantity;
        if (!taxes) {
            line.total += sign * toCents(gross);
            return;
        }
        const base = toCents(taxes.base);
        const ieps = toCents(taxes.iepsAmount);
        const iva = toCents(taxes.ivaAmount);
        line.base += sign * base;
        line.ieps += sign * ieps;
        line.iva += sign * iva;
        // Del desglose y no de `netAmount`: así base + IEPS + IVA = total al centavo.
        line.total += sign * (base + ieps + iva);
    };

    let withoutBreakdown = 0;
    for (const sale of sales) {
        if (sale.items.some((item) => !item.taxes)) {
            withoutBreakdown += 1;
        }
        for (const item of sale.items) {
            // Venta anterior al desglose: sin `netAmount` lo cobrado es la partida
            // menos su descuento; el descuento de venta no se prorrateaba entonces.
            const gross = item.netAmount ?? item.subtotal - item.discountAmount;
            if (isSaleServiceItem(item)) {
                const service = catalog.services.get(item.serviceId);
                const treatment = treatmentOf(item.taxes, () =>
                    service?.taxMode === 'exempt' ? 'exempt' : 'zero');
                const line = lineFor(`service:${item.serviceId}:${treatment}`, () => ({
                    concept: item.serviceName,
                    code: service?.code ?? '',
                    treatment,
                    ivaRate: item.taxes?.ivaRate ?? 0,
                }));
                post(line, 1, item.quantity, item.taxes, gross);
                continue;
            }
            const treatment = productTreatment(item.productId, item.taxes);
            const line = lineFor(`product:${item.productId}:${treatment}`, () => ({
                ...productSeed(item.productId, item.productName),
                treatment,
                ivaRate: item.taxes?.ivaRate ?? 0,
            }));
            post(line, 1, item.quantity, item.taxes, gross);
        }
    }

    for (const saleReturn of returns) {
        for (const item of saleReturn.items) {
            const treatment = productTreatment(item.productId, item.taxes);
            const line = lineFor(`product:${item.productId}:${treatment}`, () => ({
                ...productSeed(item.productId, item.productName),
                treatment,
                ivaRate: item.taxes.ivaRate,
            }));
            post(line, -1, item.quantity, item.taxes, item.refundAmount);
        }
    }

    const rows = [...lines.values()]
        .sort((a, b) => TREATMENT_ORDER[a.treatment] - TREATMENT_ORDER[b.treatment] ||
            a.concept.localeCompare(b.concept, 'es'))
        .map((line) => {
            const hasBreakdown = line.treatment !== 'none';
            const baseIn = (treatment: IvaTreatment) =>
                line.treatment === treatment ? fromCents(line.base) : null;
            return {
                concept: line.concept,
                code: line.code,
                ivaRate: rateLabel(line),
                quantity: line.quantity,
                base16: baseIn('standard'),
                base0: baseIn('zero'),
                baseExempt: baseIn('exempt'),
                ieps: hasBreakdown ? fromCents(line.ieps) : null,
                iva: hasBreakdown ? fromCents(line.iva) : null,
                total: fromCents(line.total),
            };
        });

    return { rows, withoutBreakdown, exemptProducts: exemptProductIds.size };
};

/** Fichas de lo vendido o devuelto en el periodo, más el catálogo de servicios. */
const loadTaxCatalog = async (
    sales: readonly Sale[],
    returns: readonly SaleReturn[],
): Promise<TaxCatalog> => {
    const productIds = new Set<string>();
    let hasServices = false;
    for (const sale of sales) {
        for (const item of sale.items) {
            if (isSaleServiceItem(item)) {
                hasServices = true;
            } else {
                productIds.add(item.productId);
            }
        }
    }
    for (const saleReturn of returns) {
        saleReturn.productIds.forEach((id) => productIds.add(id));
    }
    const [products, services] = await Promise.all([
        productsRepo.getProductsByIds([...productIds]),
        // El catálogo de servicios es corto; leerlo entero cuesta menos que uno por id.
        hasServices ? pharmacyServicesRepo.listPharmacyServices() : Promise.resolve([]),
    ]);
    return {
        products,
        services: new Map(services.map((service) => [service.id, service])),
    };
};

/**
 * IVA por producto (y por servicio) del periodo: lo que el contador necesita
 * para la declaración mensual. Las columnas de base van separadas por régimen
 * —16 %, 0 % y exento— porque así se capturan en la declaración: la suma de
 * cada columna en Excel es el renglón que se declara, sin tablas dinámicas.
 */
export const ivaPorProducto: ReportDefinition = {
    key: 'iva-por-producto',
    title: 'IVA por producto',
    // Un renglón por producto vendido: un mes de farmacia pasa de las 500 filas
    // de la vista previa general, y buscar un producto en ella debe encontrarlo.
    previewMaxRows: 5000,
    columns: [
        { key: 'concept', header: 'Producto o servicio', type: 'text' },
        { key: 'code', header: 'Clave', type: 'text' },
        { key: 'ivaRate', header: 'IVA', type: 'text' },
        { key: 'quantity', header: 'Unidades', type: 'int', total: true },
        { key: 'base16', header: 'Base 16 %', type: 'money', total: true },
        { key: 'base0', header: 'Base 0 %', type: 'money', total: true },
        { key: 'baseExempt', header: 'Exento', type: 'money', total: true },
        { key: 'ieps', header: 'IEPS', type: 'money', total: true },
        { key: 'iva', header: 'IVA trasladado', type: 'money', total: true },
        { key: 'total', header: 'Total cobrado', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now, getMaxReportSpanDays('financial'));
        const [{ items: sales }, returns] = await Promise.all([
            // Por fecha de negocio (SPEC 51), igual que `impuestos`.
            salesRepo.listSales({ from: range.from, to: range.to, byBusinessDate: true }),
            returnsRepo.listSaleReturns({ from: range.from, to: range.to }),
        ]);
        const catalog = await loadTaxCatalog(sales, returns);
        const { rows, withoutBreakdown, exemptProducts } =
            buildTaxByProductRows(sales, returns, catalog);
        const total = (key: string) => formatCurrency(sumColumn(rows, key));
        const notes = [
            // Lo primero que se busca en el PDF: los renglones de la declaración.
            `Para la declaración: base 16 % ${total('base16')} con IVA trasladado `
            + `${total('iva')}; base 0 % ${total('base0')}; exento ${total('baseExempt')}; `
            + `IEPS ${total('ieps')}.`,
            'Los precios incluyen impuestos: base, IEPS e IVA se desglosan hacia atrás de lo '
            + 'cobrado, ya con descuentos, promociones y cupones. Las ventas anuladas no se '
            + 'incluyen y las devoluciones se restan en el periodo en que se reembolsaron, por '
            + 'eso un renglón puede salir negativo.',
            'Base, IEPS e IVA cuadran con el reporte "Impuestos IVA e IEPS" del mismo periodo.',
            'Tasa 0 % y exento se distinguen con la ficha actual del producto o servicio.',
        ];
        if (exemptProducts > 0) {
            notes.push(
                `${exemptProducts} productos no tienen marcado "IVA" ni "IVA 0" en su ficha y se `
                + 'reportan como exentos. Si son medicamentos, corresponden a tasa 0 %: '
                + 'corrige la ficha del producto.',
            );
        }
        if (withoutBreakdown > 0) {
            notes.push(
                `${withoutBreakdown} ventas anteriores al desglose fiscal aparecen como "Sin `
                + 'desglose": cuentan en el total cobrado pero no en base, IEPS ni IVA.',
            );
        }
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            notes,
            emptyMessage: 'Sin ventas en el periodo.',
        };
    },
};

export const taxDefinitions: ReportDefinition[] = [ivaPorProducto];
