import * as fs from 'fs';
import * as path from 'path';
import { Query, Timestamp } from 'firebase-admin/firestore';
import * as salesService from '../src/services/sales.service';
import { clearPaginationCountCache } from '../src/utils/firestore-pagination';
import { db } from '../src/utils/firestore';

/**
 * SPEC 19: el historial filtra por forma de pago y por revisión de promoción en
 * la consulta de Firestore, excluye anuladas del total y se recorre con cursor
 * sin leer más de `limit + 1` documentos por petición.
 *
 * Las ventas se siembran a mano dentro de una ventana propia (`from`/`to`) para no
 * mezclarse con las que dejan otras suites en la misma base.
 */

const START = new Date('2031-03-01T00:00:00Z');
const END = new Date('2031-03-31T23:59:59Z');
const WINDOW = { from: START.toISOString(), to: END.toISOString() };
const at = (index: number) => Timestamp.fromMillis(START.getTime() + index * 60_000);

type Seed = { method: 'cash' | 'card' | 'transfer' | 'mixed'; review: boolean; voided: boolean };

/** Reparte formas de pago, revisiones y anuladas con proporciones conocidas. */
const plan = (count: number): Seed[] =>
    Array.from({ length: count }, (_, i) => ({
        method: (['cash', 'card', 'transfer', 'mixed'] as const)[i % 4],
        review: i % 10 === 0,
        voided: i % 7 === 0,
    }));

const seed = async (seeds: Seed[]) => {
    for (let from = 0; from < seeds.length; from += 300) {
        const batch = db().batch();
        seeds.slice(from, from + 300).forEach((s, offset) => {
            const i = from + offset;
            batch.set(db().collection('sales').doc(), {
                folio: `H-${i}`,
                createdAt: at(i),
                items: [],
                total: 10,
                paymentMethod: s.method,
                voidedAt: s.voided ? at(i) : null,
                ...(s.review ? { promotionReview: true } : {}),
            });
        });
        await batch.commit();
    }
};

const walk = async (
    filters: Parameters<typeof salesService.listSales>[0],
    limit: number,
) => {
    const sales: { folio: string; paymentMethod: string; voidedAt: unknown }[] = [];
    let after: string | undefined;
    let total = -1;
    for (let guard = 0; guard < 100; guard += 1) {
        const page = await salesService.listSales({ ...WINDOW, ...filters, limit, after });
        sales.push(...page.items);
        total = page.meta.total;
        after = page.meta.nextCursor;
        if (!after) {
            break;
        }
    }
    return { sales, total };
};

const spyReads = () => {
    const reads: number[] = [];
    const original = Query.prototype.get;
    const spy = jest.spyOn(Query.prototype, 'get').mockImplementation(async function (
        this: Query,
    ) {
        const snapshot = await original.call(this);
        reads.push(snapshot.size);
        return snapshot;
    });
    return { reads, restore: () => spy.mockRestore() };
};

const seeds = plan(600);
const vigentes = seeds.filter((s) => !s.voided);

describe('historial de ventas: filtros en el servidor (SPEC 19)', () => {
    beforeAll(async () => {
        await seed(seeds);
    });

    beforeEach(() => clearPaginationCountCache());

    it('recorre 600 ventas con cursor sin leer más de limit + 1 por petición', async () => {
        const spy = spyReads();
        try {
            const { sales, total } = await walk({}, 50);

            expect(sales).toHaveLength(vigentes.length);
            expect(total).toBe(vigentes.length);
            // `count()` es una agregación y no entra en `get()`: todas las lecturas
            // de documentos son páginas de a lo más `limit + 1`.
            expect(Math.max(...spy.reads)).toBeLessThanOrEqual(51);
        } finally {
            spy.restore();
        }
    });

    it('paymentMethod=cash devuelve solo efectivo y el total coincide', async () => {
        const esperadas = vigentes.filter((s) => s.method === 'cash').length;
        const { sales, total } = await walk({ paymentMethod: 'cash' }, 20);

        expect(sales).toHaveLength(esperadas);
        expect(total).toBe(esperadas);
        expect(sales.every((s) => s.paymentMethod === 'cash')).toBe(true);
    });

    it('promotionReview=true devuelve solo las de revisión y hay nextCursor', async () => {
        const esperadas = vigentes.filter((s) => s.review).length;
        const primera = await salesService.listSales({
            ...WINDOW,
            promotionReview: true,
            limit: 10,
        });

        expect(primera.meta.total).toBe(esperadas);
        expect(primera.meta.nextCursor).toBeTruthy();
        expect(primera.items.length).toBeLessThanOrEqual(10);

        const { sales } = await walk({ promotionReview: true }, 10);
        expect(sales).toHaveLength(esperadas);
    });

    it('combina forma de pago y revisión de promoción', async () => {
        const esperadas = vigentes.filter((s) => s.method === 'cash' && s.review).length;
        const { sales, total } = await walk({ paymentMethod: 'cash', promotionReview: true }, 5);

        expect(sales).toHaveLength(esperadas);
        expect(total).toBe(esperadas);
        expect(sales.every((s) => s.paymentMethod === 'cash')).toBe(true);
    });

    it('el total por defecto no cuenta las anuladas', async () => {
        const page = await salesService.listSales({ ...WINDOW, limit: 10 });

        expect(page.meta.total).toBe(vigentes.length);
        expect(page.items.every((s) => s.voidedAt === null)).toBe(true);
    });

    it('con includeVoided=true se incluyen y cuentan', async () => {
        const page = await salesService.listSales({ ...WINDOW, includeVoided: true, limit: 10 });

        expect(page.meta.total).toBe(seeds.length);
    });

    it('includeVoided con forma de pago filtra en memoria con total exacto', async () => {
        const esperadas = seeds.filter((s) => s.method === 'cash').length;
        const page = await salesService.listSales({
            ...WINDOW,
            includeVoided: true,
            paymentMethod: 'cash',
            limit: 10,
        });

        expect(page.meta.total).toBe(esperadas);
        expect(page.items.every((s) => s.paymentMethod === 'cash')).toBe(true);
    });

    it('un rango sin ventas devuelve lista vacía y total 0', async () => {
        const page = await salesService.listSales({
            from: '2040-01-01T00:00:00Z',
            to: '2040-01-31T00:00:00Z',
            paymentMethod: 'card',
            limit: 10,
        });

        expect(page.items).toEqual([]);
        expect(page.meta.total).toBe(0);
        expect(page.meta.nextCursor).toBeUndefined();
    });

    it('firestore.indexes.json declara los cuatro índices compuestos de sales', () => {
        const file = path.resolve(__dirname, '../../firestore.indexes.json');
        const { indexes } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[];
        };
        const sales = indexes
            .filter((i) => i.collectionGroup === 'sales')
            .map((i) => i.fields.map((f) => f.fieldPath).join(','));

        for (const expected of [
            'voidedAt,createdAt',
            'voidedAt,paymentMethod,createdAt',
            'voidedAt,promotionReview,createdAt',
            'voidedAt,paymentMethod,promotionReview,createdAt',
        ]) {
            expect(sales).toContain(expected);
        }
    });
});
