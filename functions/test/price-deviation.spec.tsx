import { renderToStaticMarkup } from 'react-dom/server';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import * as productsService from '../src/services/products.service';
import * as salesService from '../src/services/sales.service';
import { buildDailyReport } from '../src/services/sales-reports.service';
import { buildReportPreview } from '../src/services/report-export/export-report';
import { REPORT_KEYS, REPORT_REGISTRY } from '../src/services/report-export/registry';
import { SalesReportEmail } from '../src/emails/sales-report.email';
import { updateProductSchema } from '../src/schemas';
import { getPriceDeviationAlertMxn } from '../src/config/env';
import { priceDeviationLines } from '../src/utils/price-deviation';
import { Sale } from '../src/types';
import { db, toTimestamp } from '../src/utils/firestore';
import { getZonedYmd } from '../src/utils/timezone';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
}));

jest.mock('../src/services/email.service', () => ({
    sendReportEmail: jest.fn().mockResolvedValue(undefined),
}));

/**
 * SPEC 64 — precio cobrado distinto al catálogo y cambios de grupo controlado.
 * La caja sigue pudiendo editar ambos; lo que se agrega es que se vean.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const ADMIN = { userId: 'admin-user', roleSlug: 'admin' };
const today = () => getZonedYmd(Date.now(), 'America/Mexico_City');

let category: { id: string };

beforeAll(async () => {
    category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
});

const createProduct = async (overrides: Record<string, unknown> = {}) => {
    const product = await productsService.createProduct({
        name: unique('Paracetamol'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 50,
        minStock: 1,
        hasIva: false,
        hasIvaZero: true,
        hasIeps: false,
        ...overrides,
    } as Parameters<typeof productsService.createProduct>[0]);
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('L'),
        expiryDate: toTimestamp('2028-01-01'),
        quantity: 100,
        costPrice: 10,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 100 });
    return product;
};

const openSession = () => cashSessionsRepo.createCashSession({
    openedBy: 'admin-user',
    openingAmount: 0,
    expectedCashAmount: null,
    countedCashAmount: null,
    cashDifference: null,
    closedBy: null,
    closedAt: null,
});

type SaleItems = Parameters<typeof salesService.createSale>[0]['items'];

const sell = async (items: SaleItems, sessionId: string) => salesService.createSale({
    items,
    paymentMethod: 'card',
    cashSessionId: sessionId,
    cashierId: 'admin-user',
});

const loadReport = async () => {
    const definition = REPORT_REGISTRY.get('precio-distinto')!;
    const data = await definition.load({
        query: { from: today(), to: today() },
        now: new Date(),
        roleSlug: 'admin',
    });
    return { definition, data };
};

describe('priceDeviationLines', () => {
    const sale = (items: unknown[]) => ({ items } as Pick<Sale, 'items'>);

    it('compara el unitario, no el neto: promoción y descuento no cuentan', () => {
        expect(priceDeviationLines(sale([{
            kind: 'product', productId: 'p', productName: 'A', quantity: 2, unitPrice: 50,
            discountAmount: 30, subtotal: 100, batchAllocations: [],
        }]))).toEqual([]);
    });

    it('venta por caja: contra el precio de caja y en cajas', () => {
        expect(priceDeviationLines(sale([{
            kind: 'product', productId: 'p', productName: 'Amoxi', quantity: 20, unitPrice: 17,
            catalogUnitPrice: 180, discountAmount: 0, subtotal: 340, batchAllocations: [],
            saleUnit: { type: 'box', boxes: 2, piecesPerBox: 10, boxPrice: 170 },
        }]))).toEqual([{
            name: 'Amoxi (caja de 10)',
            catalogUnitPrice: 180,
            unitPrice: 170,
            quantity: 2,
            difference: -20,
        }]);
    });

    it('servicios también, y la venta vieja sin catalogUnitPrice no aparece', () => {
        const lines = priceDeviationLines(sale([
            {
                kind: 'service', serviceId: 's', serviceName: 'Consulta', quantity: 1,
                unitPrice: 300, catalogUnitPrice: 250, discountAmount: 0, subtotal: 300,
            },
            {
                productId: 'p', productName: 'Viejo', quantity: 1, unitPrice: 5,
                discountAmount: 0, subtotal: 5, batchAllocations: [],
            },
        ]));
        expect(lines).toEqual([expect.objectContaining({ name: 'Consulta', difference: 50 })]);
    });
});

describe('reporte precio-distinto (SPEC 64)', () => {
    it('está registrado', () => {
        expect(REPORT_KEYS).toContain('precio-distinto');
    });

    it('una venta bajo catálogo aparece con la diferencia negativa correcta', async () => {
        const session = await openSession();
        const product = await createProduct({ salePrice: 50 });
        const normal = await createProduct({ salePrice: 30 });
        const sale = await sell([
            { productId: product.id, quantity: 3, unitPrice: 42.5 },
            { productId: normal.id, quantity: 1 },
        ], session.id);

        const { definition, data } = await loadReport();
        const rows = data.rows.filter((row) => row.folio === sale.folio);
        expect(rows).toEqual([{
            date: expect.stringMatching(/^\d{2}\/\d{2}\/\d{4}$/),
            folio: sale.folio,
            cashier: expect.any(String),
            product: product.name,
            catalogUnitPrice: 50,
            unitPrice: 42.5,
            quantity: 3,
            difference: -22.5,
        }]);

        const preview = buildReportPreview(definition, rows);
        expect(preview.totals).toMatchObject({ quantity: 3, difference: -22.5 });
        expect(preview.columns.map((column) => column.key)).toEqual([
            'date', 'folio', 'cashier', 'product',
            'catalogUnitPrice', 'unitPrice', 'quantity', 'difference',
        ]);
    });

    it('las anuladas no cuentan', async () => {
        const session = await openSession();
        const product = await createProduct({ salePrice: 50 });
        const sale = await sell(
            [{ productId: product.id, quantity: 1, unitPrice: 10 }],
            session.id,
        );
        await db().collection('sales').doc(sale.id).update({
            voidedAt: toTimestamp(new Date().toISOString()),
            voidedBy: 'admin-user',
        });
        const { data } = await loadReport();
        expect(data.rows.some((row) => row.folio === sale.folio)).toBe(false);
    });
});

describe('grupo controlado (SPEC 64)', () => {
    const groupAudits = async (productId: string) =>
        (await auditRepo.listAuditLogs({ entityId: productId }))
            .filter((log) => log.action === 'product.controlled_group_changed');

    it('el PATCH acepta controlledGroup: null', () => {
        expect(updateProductSchema.safeParse({ controlledGroup: null }).success).toBe(true);
        expect(updateProductSchema.safeParse({ controlledGroup: 'IV' }).success).toBe(true);
        expect(updateProductSchema.safeParse({ controlledGroup: 'VII' }).success).toBe(false);
    });

    it('cambiar el grupo y quitarlo (null) escribe product.controlled_group_changed', async () => {
        const product = await createProduct({ controlledGroup: 'IV' });

        await productsService.updateProduct(product.id, { controlledGroup: 'II' }, ADMIN);
        await productsService.updateProduct(product.id, { controlledGroup: null }, ADMIN);

        const stored = (await db().collection('products').doc(product.id).get()).data()!;
        expect('controlledGroup' in stored).toBe(false);

        const audits = (await groupAudits(product.id))
            .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
        expect(audits.map((log) => log.changes?.controlledGroup)).toEqual([
            { before: 'IV', after: 'II' },
            { before: 'II', after: null },
        ]);
        expect(audits.every((log) => log.userId === ADMIN.userId)).toBe(true);
        expect(audits[1].summary).toContain('sin grupo');
    });

    it('sin cambio de grupo no audita', async () => {
        const product = await createProduct({ controlledGroup: 'IV' });
        await productsService.updateProduct(product.id, { controlledGroup: 'IV' }, ADMIN);
        await productsService.updateProduct(product.id, { minStock: 3 }, ADMIN);
        const plain = await createProduct();
        await productsService.updateProduct(plain.id, { controlledGroup: null }, ADMIN);
        expect(await groupAudits(product.id)).toHaveLength(0);
        expect(await groupAudits(plain.id)).toHaveLength(0);
    });
});

describe('correo diario (SPEC 64)', () => {
    const ORIGINAL = process.env.PRICE_DEVIATION_ALERT_MXN;
    afterEach(() => {
        if (ORIGINAL === undefined) {
            delete process.env.PRICE_DEVIATION_ALERT_MXN;
        } else {
            process.env.PRICE_DEVIATION_ALERT_MXN = ORIGINAL;
        }
    });

    it('PRICE_DEVIATION_ALERT_MXN: default 200 y valores inválidos caen al default', () => {
        delete process.env.PRICE_DEVIATION_ALERT_MXN;
        expect(getPriceDeviationAlertMxn()).toBe(200);
        process.env.PRICE_DEVIATION_ALERT_MXN = 'abc';
        expect(getPriceDeviationAlertMxn()).toBe(200);
        process.env.PRICE_DEVIATION_ALERT_MXN = '-5';
        expect(getPriceDeviationAlertMxn()).toBe(200);
        process.env.PRICE_DEVIATION_ALERT_MXN = '50';
        expect(getPriceDeviationAlertMxn()).toBe(50);
    });

    it('muestra la línea con las partidas bajo catálogo y lista los cambios de grupo', async () => {
        process.env.PRICE_DEVIATION_ALERT_MXN = '1000';
        // Las pruebas anteriores del archivo ya vendieron hoy: se mide la diferencia.
        const before = (await buildDailyReport(today())).priceDeviation;
        const session = await openSession();
        // Grupo V: venta libre, la venta no pide receta.
        const product = await createProduct({ salePrice: 50, controlledGroup: 'V' });
        await sell([{ productId: product.id, quantity: 2, unitPrice: 40 }], session.id);
        // Cobrado por encima: va al reporte, no a la línea "bajo catálogo".
        const other = await createProduct({ salePrice: 20 });
        await sell([{ productId: other.id, quantity: 1, unitPrice: 25 }], session.id);
        await productsService.updateProduct(product.id, { controlledGroup: null }, ADMIN);

        const report = await buildDailyReport(today());
        expect(report.priceDeviation.count - before.count).toBe(1);
        expect(report.priceDeviation.amount - before.amount).toBeCloseTo(20, 2);
        expect(report.priceDeviation).toMatchObject({ threshold: 1000, alert: false });
        const change = report.controlledGroupChanges.find(
            (entry) => entry.productName === product.name,
        );
        expect(change).toMatchObject({ before: 'V', after: null });

        const html = renderToStaticMarkup(SalesReportEmail({
            report: {
                ...report,
                priceDeviation: { count: 1, amount: 20, threshold: 1000, alert: false },
            },
        }));
        expect(html).toContain('Cobrado bajo catálogo: 1 partida, −$20.00');
        expect(html).toContain('data-alert="false"');
        expect(html).toContain('Cambios de grupo controlado (');
        expect(html).toContain(product.name);
        expect(html).toContain('Grupo V → Sin grupo');
    });

    it('destaca la línea cuando el monto supera el umbral', async () => {
        const report = await buildDailyReport(today());
        const html = renderToStaticMarkup(SalesReportEmail({
            report: {
                ...report,
                priceDeviation: { count: 4, amount: 250, threshold: 200, alert: true },
            },
        }));
        expect(html).toContain('Cobrado bajo catálogo: 4 partidas, −$250.00');
        expect(html).toContain('data-alert="true"');
        expect(html).toContain('Supera el umbral de $200.00');
    });

    it('sin partidas ni cambios no aparecen las secciones', async () => {
        const report = await buildDailyReport(today());
        const html = renderToStaticMarkup(SalesReportEmail({
            report: {
                ...report,
                priceDeviation: { count: 0, amount: 0, threshold: 200, alert: false },
                controlledGroupChanges: [],
            },
        }));
        expect(html).not.toContain('Cobrado bajo catálogo');
        expect(html).not.toContain('Cambios de grupo controlado');
    });
});
