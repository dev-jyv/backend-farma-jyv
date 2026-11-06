import { FieldValue } from 'firebase-admin/firestore';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { SalesController } from '../src/modules/sales/sales.controller';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import { LEGACY_VOID_REASON, voidSaleSchema } from '../src/schemas/sales';
import * as productsService from '../src/services/products.service';
import { REPORT_REGISTRY } from '../src/services/report-export/registry';
import * as salesService from '../src/services/sales.service';
import { AuthUser } from '../src/types';
import { AppError } from '../src/utils/errors';
import { db, toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 62 — toda anulación lleva motivo: se guarda en la venta, en la bitácora y
 * sale en el reporte `cancelaciones`. Un POS anterior, que no manda `reason`,
 * recibe el motivo por defecto y se audita igual.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const CASHIER = 'cajero-62';
const cashier = {
    uid: CASHIER,
    role: { slug: 'cashier' },
    permissions: [{ area: 'pos', level: 'write' }, { area: 'sales', level: 'read' }],
} as unknown as AuthUser;

let productId: string;
let sessionId: string;

beforeAll(async () => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    const product = await productsService.createProduct({
        name: unique('Producto'),
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'pieza',
        salePrice: 20,
        minStock: 1,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
    } as Parameters<typeof productsService.createProduct>[0]);
    await batchesRepo.createBatch({
        productId: product.id,
        lotNumber: unique('LOTE'),
        expiryDate: toTimestamp('2029-01-01'),
        quantity: 50,
        costPrice: 8,
    });
    await productsRepo.updateProduct(product.id, { totalStock: 50 });
    productId = product.id;
    sessionId = (await cashSessionsRepo.createCashSession({
        openedBy: CASHIER,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    })).id;
});

const sell = () => salesService.createSale({
    idempotencyKey: unique('llave'),
    items: [{ productId, quantity: 1, unitPrice: 20 }],
    paymentMethod: 'cash',
    amountReceived: 20,
    cashSessionId: sessionId,
    cashierId: CASHIER,
    roleSlug: 'cashier',
});

const voidAudit = async (saleId: string) => {
    const logs = await db().collection('auditLogs')
        .where('entityId', '==', saleId)
        .where('action', '==', 'sale.voided')
        .get();
    expect(logs.size).toBe(1);
    return logs.docs[0].data();
};

/** Lo que hace Nest con el cuerpo antes de llegar al handler. */
const parseBody = (body: unknown) => new ZodValidationPipe(voidSaleSchema).transform(body);

describe('SPEC 62 — motivo de anulación', () => {
    it('anular sin reason desde un payload nuevo responde 400', () => {
        for (const body of [{ reason: '' }, { reason: 'mal' }, { reason: null }]) {
            let error: unknown;
            try {
                parseBody(body);
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).statusCode).toBe(400);
        }
    });

    it('guarda el motivo en la venta, en la respuesta y en la bitácora', async () => {
        const sale = await sell();
        const controller = new SalesController();
        const { data } = await controller.void(
            { id: sale.id },
            cashier,
            parseBody({ reason: '  Error de captura ' }),
        );
        expect(data.voidReason).toBe('Error de captura');
        expect((await salesRepo.getSaleById(sale.id))?.voidReason).toBe('Error de captura');

        const audit = await voidAudit(sale.id);
        expect(audit.metadata.reason).toBe('Error de captura');
        expect(audit.metadata.reasonDefaulted).toBeUndefined();
        expect(audit.summary).toContain('Error de captura');
    });

    it('un POS anterior sin reason recibe el motivo por defecto y se audita igual', async () => {
        const sale = await sell();
        const controller = new SalesController();
        const { data } = await controller.void({ id: sale.id }, cashier, parseBody(undefined));
        expect(data.voidReason).toBe(LEGACY_VOID_REASON);

        const audit = await voidAudit(sale.id);
        expect(audit.metadata.reason).toBe(LEGACY_VOID_REASON);
        expect(audit.metadata.reasonDefaulted).toBe(true);
    });

    it('la anulación offline de dos pasos guarda el motivo junto con hora y autor', async () => {
        const sale = await sell();
        const voidedAt = new Date().toISOString();
        await salesService.voidSale(sale.id, CASHIER, 'cashier', parseBody({
            reason: 'Cliente desistió',
            voidedAt,
            voidedBy: CASHIER,
        }));
        const stored = await salesRepo.getSaleById(sale.id);
        expect(stored?.voidReason).toBe('Cliente desistió');
        expect(stored?.voidedAt?.toDate().toISOString()).toBe(voidedAt);
    });

    it('el reporte cancelaciones incluye la columna Motivo', async () => {
        const conMotivo = await sell();
        await salesService.voidSale(conMotivo.id, CASHIER, 'cashier', parseBody({
            reason: 'Producto equivocado',
        }));
        // Anulación anterior al motivo obligatorio: la venta no tiene `voidReason`.
        const vieja = await sell();
        await salesService.voidSale(vieja.id, CASHIER, 'cashier');
        await db().collection('sales').doc(vieja.id).update({ voidReason: FieldValue.delete() });

        const definition = REPORT_REGISTRY.get('cancelaciones')!;
        expect(definition.columns.map((column) => column.header)).toContain('Motivo');
        const data = await definition.load({ query: {}, now: new Date(), roleSlug: 'admin' });
        const byFolio = new Map(data.rows.map((row) => [row.folio, row]));
        expect(byFolio.get(conMotivo.folio)?.reason).toBe('Producto equivocado');
        expect(byFolio.get(vieja.folio)?.reason).toBe('Sin motivo registrado');
    });
});
