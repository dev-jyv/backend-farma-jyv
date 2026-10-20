import { Query, Timestamp } from 'firebase-admin/firestore';
import * as movementsRepo from '../src/repositories/stock-movements.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as salesRepo from '../src/repositories/sales.repository';
import {
    clearPaginationCountCache,
    decodeCursor,
    paginateQuery,
} from '../src/utils/firestore-pagination';
import { AppError } from '../src/utils/errors';
import { db } from '../src/utils/firestore';

/**
 * SPEC 08: paginación por cursor. Se fija el contrato de `paginateQuery` con
 * empates en el campo de orden (mismo `createdAt` en varias filas), el costo en
 * lecturas independiente de la profundidad, la compatibilidad `?page=N` y el
 * rechazo de cursores manipulados.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const BASE = new Date('2026-01-01T00:00:00Z');
const ts = (minutes: number) => Timestamp.fromDate(new Date(BASE.getTime() + minutes * 60_000));

/** Cuenta los documentos que devuelven las lecturas `get()` de consultas. */
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

const seedSales = async (count: number, tieEvery: number) => {
    const cashSessionId = unique('sess');
    const batch = db().batch();
    for (let i = 0; i < count; i += 1) {
        batch.set(db().collection('sales').doc(), {
            folio: `F-${i}`,
            cashSessionId,
            // Grupos de `tieEvery` ventas con exactamente el mismo createdAt.
            createdAt: ts(Math.floor(i / tieEvery)),
            items: [],
            total: 10,
            voidedAt: null,
        });
    }
    await batch.commit();
    return cashSessionId;
};

const walk = async (cashSessionId: string, limit: number, includeVoided = true) => {
    const ids: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
        const result = await salesRepo.listSalesPage({
            cashSessionId,
            includeVoided,
            page: 1,
            limit,
            after,
        });
        ids.push(...result.items.map((sale) => sale.id));
        after = result.nextCursor;
        pages += 1;
    } while (after && pages < 50);
    return ids;
};

describe('paginación por cursor (SPEC 08)', () => {
    beforeEach(() => clearPaginationCountCache());

    it('recorre todas las páginas sin duplicados ni huecos con empates en createdAt', async () => {
        const session = await seedSales(23, 5);

        const ids = await walk(session, 4);

        expect(ids).toHaveLength(23);
        expect(new Set(ids).size).toBe(23);
    });

    it('la última página no trae nextCursor y total sale de count()', async () => {
        const session = await seedSales(5, 1);

        const first = await salesRepo.listSalesPage({ cashSessionId: session, page: 1, limit: 3 });
        expect(first.items).toHaveLength(3);
        expect(first.total).toBe(5);
        expect(first.nextCursor).toBeDefined();

        const last = await salesRepo.listSalesPage({
            cashSessionId: session,
            page: 1,
            limit: 3,
            after: first.nextCursor,
        });
        expect(last.items).toHaveLength(2);
        expect(last.nextCursor).toBeUndefined();

        const exact = await salesRepo.listSalesPage({ cashSessionId: session, page: 1, limit: 5 });
        expect(exact.items).toHaveLength(5);
        expect(exact.nextCursor).toBeUndefined();
    });

    it('pedir una página profunda con cursor lee ~limit documentos, no N × limit', async () => {
        const session = await seedSales(40, 3);
        const first = await salesRepo.listSalesPage({ cashSessionId: session, page: 1, limit: 4 });
        let after = first.nextCursor;
        for (let i = 0; i < 7; i += 1) {
            const next = await salesRepo.listSalesPage({
                cashSessionId: session,
                page: 1,
                limit: 4,
                after,
            });
            after = next.nextCursor;
        }

        const spy = spyReads();
        try {
            clearPaginationCountCache();
            const deep = await salesRepo.listSalesPage({
                cashSessionId: session,
                page: 1,
                limit: 4,
                after,
            });
            expect(deep.items).toHaveLength(4);
            // Una lectura de `limit + 1` (el extra solo detecta si hay más páginas).
            expect(spy.reads).toEqual([5]);
        } finally {
            spy.restore();
        }
    });

    it('?page=N sigue funcionando y devuelve nextCursor', async () => {
        const session = await seedSales(10, 2);
        const all = await walk(session, 3);

        const page3 = await salesRepo.listSalesPage({ cashSessionId: session, page: 3, limit: 3 });
        expect(page3.items.map((s) => s.id)).toEqual(all.slice(6, 9));
        expect(page3.nextCursor).toBeDefined();

        const page4 = await salesRepo.listSalesPage({ cashSessionId: session, page: 4, limit: 3 });
        expect(page4.items.map((s) => s.id)).toEqual(all.slice(9));
        expect(page4.nextCursor).toBeUndefined();

        const beyond = await salesRepo.listSalesPage({ cashSessionId: session, page: 9, limit: 3 });
        expect(beyond.items).toEqual([]);
        expect(beyond.nextCursor).toBeUndefined();
    });

    it('rellena la página saltando anuladas sin perder ni repetir ventas', async () => {
        const session = await seedSales(12, 1);
        const snap = await db().collection('sales').where('cashSessionId', '==', session).get();
        const voided = snap.docs.filter((_, i) => i % 2 === 0);
        await Promise.all(voided.map((doc) => doc.ref.update({ voidedAt: ts(999) })));

        const ids = await walk(session, 4, false);

        expect(ids).toHaveLength(6);
        expect(new Set(ids).size).toBe(6);
        expect(ids.every((id) => !voided.some((doc) => doc.id === id))).toBe(true);
    });

    it('un cursor inválido o manipulado responde 400', async () => {
        const session = await seedSales(3, 1);
        const first = await salesRepo.listSalesPage({ cashSessionId: session, page: 1, limit: 1 });
        const valid = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));

        const encode = (value: unknown) =>
            Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
        const bad = [
            'no-es-un-cursor!!',
            Buffer.from('no es json').toString('base64url'),
            encode({ v: [], id: 'x' }),
            encode({ v: valid.v, id: '' }),
            encode({ v: valid.v, id: 'otra/coleccion/doc' }),
            encode({ v: [{ t: ['a', 'b'] }], id: 'x' }),
            encode({ v: [{ otro: 1 }], id: 'x' }),
            'a'.repeat(3000),
        ];

        for (const after of bad) {
            const error = await salesRepo
                .listSalesPage({ cashSessionId: session, page: 1, limit: 1, after })
                .catch((e) => e);
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).statusCode).toBe(400);
        }
        expect(() => decodeCursor('x', [{ field: 'a', direction: 'asc' }])).toThrow(AppError);
    });

    it('un cursor manipulado nunca lee fuera del filtro', async () => {
        const sessionA = await seedSales(3, 1);
        const sessionB = await seedSales(3, 1);
        const other = await db().collection('sales').where('cashSessionId', '==', sessionB).get();
        const forged = Buffer.from(
            JSON.stringify({ v: [{ t: [0, 0] }], id: other.docs[0].id }),
            'utf8',
        ).toString('base64url');

        const result = await salesRepo.listSalesPage({
            cashSessionId: sessionA,
            page: 1,
            limit: 10,
            after: forged,
        });

        const ids = result.items.map((s) => s.id);
        expect(ids).not.toContain(other.docs[0].id);
        expect(ids.every((id) => !other.docs.some((d) => d.id === id))).toBe(true);
    });

    it('si el documento del cursor se elimina, continúa con el siguiente valor de orden', async () => {
        const session = await seedSales(6, 1);
        const first = await salesRepo.listSalesPage({ cashSessionId: session, page: 1, limit: 2 });
        const cursorId = JSON.parse(
            Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
        ).id as string;
        await db().collection('sales').doc(cursorId).delete();

        const next = await salesRepo.listSalesPage({
            cashSessionId: session,
            page: 1,
            limit: 2,
            after: first.nextCursor,
        });

        expect(next.items).toHaveLength(2);
        expect(next.items.map((s) => s.id)).not.toContain(cursorId);
    });

    it('cachea el count() 60 s por combinación de filtros', async () => {
        const col = db().collection(unique('col'));
        await col.doc('a').set({ n: 1 });
        const query = col.orderBy('n', 'asc');
        const options = {
            order: [{ field: 'n', direction: 'asc' as const }],
            countCacheKey: unique('k'),
        };
        const map = (doc: FirebaseFirestore.QueryDocumentSnapshot) => doc.id;

        const first = await paginateQuery(query, map, 1, 10, options);
        await col.doc('b').set({ n: 2 });
        const second = await paginateQuery(query, map, 1, 10, options);
        const otherKey = await paginateQuery(query, map, 1, 10, {
            ...options,
            countCacheKey: unique('k'),
        });

        expect(first.total).toBe(1);
        expect(second.total).toBe(1);
        expect(second.items).toHaveLength(2);
        expect(otherKey.total).toBe(2);
    });

    it('productos: pagina por cursor en orden de nombre y respeta filtros', async () => {
        const categoryId = unique('cat');
        const suffix = unique('p');
        for (const name of ['A', 'B', 'C', 'D', 'E']) {
            await productsRepo.createProduct({
                name: `${name}-${suffix}`,
                sku: unique('SKU'),
                categoryId,
                unit: 'pieza',
                salePrice: 1,
                minStock: 0,
                totalStock: 0,
                hasIva: true,
                hasIvaZero: false,
                hasIeps: false,
                isActive: true,
                requiresPrescription: false,
                suppliers: [],
            });
        }

        const p1 = await productsRepo.listProductsPage({ categoryId, page: 1, limit: 2 });
        const p2 = await productsRepo.listProductsPage({
            categoryId,
            page: 1,
            limit: 2,
            after: p1.nextCursor,
        });
        const p3 = await productsRepo.listProductsPage({
            categoryId,
            page: 1,
            limit: 2,
            after: p2.nextCursor,
        });

        const names = [...p1.items, ...p2.items, ...p3.items].map((p) => p.name[0]);
        expect(names).toEqual(['A', 'B', 'C', 'D', 'E']);
        expect(p1.total).toBe(5);
        expect(p3.nextCursor).toBeUndefined();
    });

    it('movimientos de stock: cursor sin duplicados con empates y filtros', async () => {
        const productId = unique('prod');
        const batch = db().batch();
        for (let i = 0; i < 9; i += 1) {
            batch.set(db().collection('stockMovements').doc(), {
                productId,
                type: 'entry',
                quantity: 1,
                createdAt: ts(Math.floor(i / 3)),
            });
        }
        await batch.commit();

        const ids: string[] = [];
        let after: string | undefined;
        do {
            const page = await movementsRepo.listStockMovementsPage({
                productId,
                page: 1,
                limit: 4,
                after,
            });
            expect(page.total).toBe(9);
            ids.push(...page.items.map((m) => m.id));
            after = page.nextCursor;
        } while (after);

        expect(ids).toHaveLength(9);
        expect(new Set(ids).size).toBe(9);
    });
});
