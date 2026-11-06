import { SalesController } from '../src/modules/sales/sales.controller';
import * as batchesRepo from '../src/repositories/batches.repository';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import { createSaleSchema } from '../src/schemas';
import * as productsService from '../src/services/products.service';
import { AuthUser } from '../src/types';
import { toTimestamp } from '../src/utils/firestore';

jest.mock('../src/services/mercado-pago.service', () => ({
    getOrder: jest.fn(),
}));

/**
 * SPEC 65, punto 6 — la venta guarda el desfase del reloj de la caja
 * (`clockSkewMs`) cuando viene. Es informativo: no rechaza ni cambia la huella.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const CASHIER = 'cajero-65';
const user = {
    uid: CASHIER,
    role: { slug: 'cashier' },
    permissions: [{ area: 'pos', level: 'write' }],
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
    const session = await cashSessionsRepo.createCashSession({
        openedBy: CASHIER,
        openingAmount: 0,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        closedBy: null,
        closedAt: null,
    });
    sessionId = session.id;
});

const payload = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: unique('llave'),
    items: [{ productId, quantity: 1, unitPrice: 20 }],
    paymentMethod: 'cash',
    amountReceived: 20,
    cashSessionId: sessionId,
    soldAt: new Date().toISOString(),
    ...overrides,
});

describe('SPEC 65 — Sale.clockSkewMs', () => {
    it('el schema acepta el desfase numérico y lo deja fuera si no viene', () => {
        const withSkew = createSaleSchema.parse(payload({ clockSkewMs: -125_000.5 }));
        expect(withSkew.clockSkewMs).toBe(-125_000.5);
        expect(createSaleSchema.parse(payload()).clockSkewMs).toBeUndefined();
        expect(createSaleSchema.parse(payload({ clockSkewMs: null })).clockSkewMs)
            .toBeUndefined();
        expect(createSaleSchema.safeParse(payload({ clockSkewMs: '3h' })).success).toBe(false);
    });

    it('la venta del lote guarda clockSkewMs y mapSale lo devuelve', async () => {
        const controller = new SalesController();
        const { data } = await controller.bulkCreate(
            { items: [payload({ clockSkewMs: 10_800_000 }), payload()] },
            user,
        );
        expect(data[0].ok).toBe(true);
        expect(data[1].ok).toBe(true);
        const [withSkew, without] = data.map((result) => (result.ok ? result.sale : null));

        expect(withSkew?.clockSkewMs).toBe(10_800_000);
        expect((await salesRepo.getSaleById(withSkew!.id))?.clockSkewMs).toBe(10_800_000);
        expect(without).not.toHaveProperty('clockSkewMs');
        expect(await salesRepo.getSaleById(without!.id)).not.toHaveProperty('clockSkewMs');
    });

    it('un reintento con otro desfase devuelve la misma venta (no entra a la huella)', async () => {
        const controller = new SalesController();
        const sale = payload({ clockSkewMs: 1_000 });
        const first = await controller.bulkCreate({ items: [sale] }, user);
        const retry = await controller.bulkCreate(
            { items: [{ ...sale, clockSkewMs: 2_000 }] },
            user,
        );
        expect(first.data[0].ok && retry.data[0].ok).toBe(true);
        if (first.data[0].ok && retry.data[0].ok) {
            expect(retry.data[0].sale.id).toBe(first.data[0].sale.id);
            expect(retry.data[0].sale.clockSkewMs).toBe(1_000);
        }
    });
});
