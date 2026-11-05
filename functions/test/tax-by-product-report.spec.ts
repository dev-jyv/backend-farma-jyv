import * as pharmacyServicesRepo from '../src/repositories/pharmacy-services.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as returnsRepo from '../src/repositories/sale-returns.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import {
    REPORT_DOWNLOAD_KEYS,
    REPORT_PREVIEW_MAX_ROWS,
    assertCanExportReport,
    buildReportPreview,
} from '../src/services/report-export/export-report';
import {
    TaxCatalog,
    buildTaxByProductRows,
    ivaPorProducto,
} from '../src/services/report-export/definitions/tax-by-product';
import { REPORT_REGISTRY } from '../src/services/report-export/registry';
import { Sale, SaleItemTaxes, SaleReturn } from '../src/types';
import { breakdownWithRates } from '../src/utils/taxes';

jest.mock('../src/repositories/sales.repository');
jest.mock('../src/repositories/sale-returns.repository');
jest.mock('../src/repositories/products.repository');
jest.mock('../src/repositories/pharmacy-services.repository');

/** Desglose real de `utils/taxes`, para que los importes cuadren como en una venta. */
const taxes = (gross: number, ivaRate: number, iepsRate = 0): SaleItemTaxes =>
    breakdownWithRates({ grossAmount: gross, ivaRate, iepsRate });

const product = (
    productId: string,
    productName: string,
    quantity: number,
    gross: number,
    itemTaxes: SaleItemTaxes | undefined,
) => ({
    kind: 'product' as const,
    productId,
    productName,
    quantity,
    unitPrice: gross / quantity,
    discountAmount: 0,
    subtotal: gross,
    netAmount: itemTaxes ? gross : undefined,
    taxes: itemTaxes,
    batchAllocations: [],
});

const service = (serviceId: string, serviceName: string, gross: number, ivaRate: number) => ({
    kind: 'service' as const,
    serviceId,
    serviceName,
    quantity: 1,
    unitPrice: gross,
    discountAmount: 0,
    subtotal: gross,
    netAmount: gross,
    taxes: taxes(gross, ivaRate),
    providerId: null,
    providerName: null,
    commissionRate: 0,
    commissionAmount: 0,
});

const sale = (items: unknown[]): Sale => ({ items } as unknown as Sale);

const catalog: TaxCatalog = {
    products: new Map([
        ['shampoo', { name: 'Shampoo 400 ml', sku: 'SH-1', hasIva: true, hasIvaZero: false }],
        ['paracetamol', {
            name: 'Paracetamol 500 mg', sku: 'PA-1', hasIva: false, hasIvaZero: true,
        }],
        // Sin "IVA" ni "IVA 0": la convención del sistema lo trata como exento.
        ['vendas', { name: 'Vendas elásticas', sku: 'VE-1', hasIva: false, hasIvaZero: false }],
    ]),
    services: new Map([
        ['consulta', { code: 'CON', taxMode: 'exempt' as const }],
        ['inyeccion', { code: 'INY', taxMode: 'iva16' as const }],
    ]),
};

const sales: Sale[] = [
    sale([
        product('shampoo', 'Shampoo', 2, 232, taxes(232, 0.16)),
        product('paracetamol', 'Paracetamol', 3, 90, taxes(90, 0)),
        service('consulta', 'Consulta general', 300, 0),
    ]),
    sale([
        product('shampoo', 'Shampoo', 1, 116, taxes(116, 0.16)),
        product('vendas', 'Vendas', 1, 45, taxes(45, 0)),
        service('inyeccion', 'Aplicación de inyección', 58, 0.16),
    ]),
    // Venta anterior al desglose fiscal.
    sale([product('paracetamol', 'Paracetamol', 1, 30, undefined)]),
];

const returns: SaleReturn[] = [{
    productIds: ['shampoo'],
    items: [{
        productId: 'shampoo',
        productName: 'Shampoo',
        quantity: 1,
        unitPrice: 116,
        refundAmount: 116,
        taxes: taxes(116, 0.16),
        batchAllocations: [],
    }],
} as unknown as SaleReturn];

describe('buildTaxByProductRows', () => {
    const result = buildTaxByProductRows(sales, returns, catalog);

    it('un renglón por concepto y régimen, ordenado 16 %, 0 %, exento y sin desglose', () => {
        expect(result.rows.map((row) => [row.concept, row.ivaRate])).toEqual([
            ['Aplicación de inyección', '16 %'],
            ['Shampoo 400 ml', '16 %'],
            ['Paracetamol 500 mg', '0 %'],
            ['Consulta general', 'Exento'],
            ['Vendas elásticas', 'Exento'],
            ['Paracetamol 500 mg', 'Sin desglose'],
        ]);
    });

    it('resta la devolución con las tasas de la venta y deja la base en su columna', () => {
        const shampoo = result.rows.find((row) => row.code === 'SH-1');
        // Vendidos 3 por $348, devuelto 1 por $116: quedan 2 por $232.
        expect(shampoo).toEqual({
            concept: 'Shampoo 400 ml',
            code: 'SH-1',
            ivaRate: '16 %',
            quantity: 2,
            base16: 200,
            base0: null,
            baseExempt: null,
            ieps: 0,
            iva: 32,
            total: 232,
        });
    });

    it('separa tasa 0 % de exento con la ficha, en productos y en servicios', () => {
        const byCode = new Map(result.rows.map((row) => [`${row.code}:${row.ivaRate}`, row]));
        expect(byCode.get('PA-1:0 %')).toMatchObject({ base0: 90, baseExempt: null, iva: 0 });
        expect(byCode.get('VE-1:Exento')).toMatchObject({ base0: null, baseExempt: 45 });
        expect(byCode.get('CON:Exento')).toMatchObject({ baseExempt: 300, total: 300 });
        expect(byCode.get('INY:16 %')).toMatchObject({ base16: 50, iva: 8, total: 58 });
        expect(result.exemptProducts).toBe(1);
    });

    it('la venta sin desglose cuenta en el total pero no en base ni impuestos', () => {
        expect(result.rows[result.rows.length - 1]).toMatchObject({
            ivaRate: 'Sin desglose',
            quantity: 1,
            base16: null,
            base0: null,
            baseExempt: null,
            iva: null,
            total: 30,
        });
        expect(result.withoutBreakdown).toBe(1);
    });

    it('cada renglón cuadra al centavo: bases + IEPS + IVA = total', () => {
        const cents = (value: unknown) => Math.round(((value as number | null) ?? 0) * 100);
        for (const row of result.rows.filter((r) => r.ivaRate !== 'Sin desglose')) {
            const parts = cents(row.base16) + cents(row.base0) + cents(row.baseExempt)
                + cents(row.ieps) + cents(row.iva);
            expect(parts).toBe(cents(row.total));
        }
    });

    it('con IEPS el impuesto sale en su columna y el renglón sigue cuadrando', () => {
        const { rows } = buildTaxByProductRows(
            [sale([product('shampoo', 'Shampoo', 1, 125.28, taxes(125.28, 0.16, 0.08))])],
            [],
            catalog,
        );
        expect(rows[0]).toMatchObject({ base16: 100, ieps: 8, iva: 17.28, total: 125.28 });
    });

    it('una ficha borrada que se vendió en cero cae en tasa 0 % con el nombre de la venta', () => {
        const { rows, exemptProducts } = buildTaxByProductRows(
            [sale([product('borrado', 'Ibuprofeno 400 mg', 1, 40, taxes(40, 0))])],
            [],
            catalog,
        );
        expect(rows[0]).toMatchObject({ concept: 'Ibuprofeno 400 mg', code: '', base0: 40 });
        expect(exemptProducts).toBe(0);
    });
});

describe('reporte iva-por-producto', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (salesRepo.listSales as jest.Mock).mockResolvedValue({ items: sales, total: sales.length });
        (returnsRepo.listSaleReturns as jest.Mock).mockResolvedValue(returns);
        (productsRepo.getProductsByIds as jest.Mock).mockResolvedValue(catalog.products);
        (pharmacyServicesRepo.listPharmacyServices as jest.Mock).mockResolvedValue(
            [...catalog.services.entries()].map(([id, value]) => ({ id, ...value })),
        );
    });

    it('está registrado y el contador lo puede sacar', () => {
        expect(REPORT_REGISTRY.get('iva-por-producto')).toBe(ivaPorProducto);
        expect(REPORT_DOWNLOAD_KEYS).toContain('iva-por-producto');
        expect(() => assertCanExportReport('iva-por-producto', {}, {
            roleSlug: 'accountant',
            permissions: [{ area: 'reportDownloads', level: 'read' }],
        })).not.toThrow();
    });

    it('lee solo los productos del periodo y resume la declaración al pie', async () => {
        const data = await ivaPorProducto.load({
            query: { month: '2026-10' },
            now: new Date('2026-11-04T18:00:00Z'),
            roleSlug: 'accountant',
        });
        const ids = (productsRepo.getProductsByIds as jest.Mock).mock.calls[0][0];
        expect([...ids].sort()).toEqual(['paracetamol', 'shampoo', 'vendas']);
        expect(data.notes?.[0]).toBe(
            'Para la declaración: base 16 % $250.00 con IVA trasladado $40.00; base 0 % $90.00; '
            + 'exento $345.00; IEPS $0.00.',
        );
        expect(data.notes?.join(' ')).toContain('1 productos no tienen marcado');
        expect(data.notes?.join(' ')).toContain('1 ventas anteriores al desglose');
    });

    it('sin servicios vendidos no lee el catálogo de servicios', async () => {
        (salesRepo.listSales as jest.Mock).mockResolvedValue({ items: [sales[2]], total: 1 });
        (returnsRepo.listSaleReturns as jest.Mock).mockResolvedValue([]);
        await ivaPorProducto.load({
            query: { month: '2026-10' },
            now: new Date('2026-11-04T18:00:00Z'),
            roleSlug: 'admin',
        });
        expect(pharmacyServicesRepo.listPharmacyServices).not.toHaveBeenCalled();
    });

    it('la vista previa usa su propio tope, no el general de 500 filas', () => {
        const rows = Array.from({ length: REPORT_PREVIEW_MAX_ROWS + 1 }, (_, i) => ({
            concept: `P${i}`,
            total: 1,
        }));
        const preview = buildReportPreview(ivaPorProducto, rows);
        expect(preview.rows).toHaveLength(REPORT_PREVIEW_MAX_ROWS + 1);
        expect(preview.truncated).toBe(false);
        expect(preview.totals.total).toBe(REPORT_PREVIEW_MAX_ROWS + 1);
    });
});
