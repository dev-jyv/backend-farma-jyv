import { Timestamp } from 'firebase-admin/firestore';
import { CashSessionsController } from '../src/modules/cash-sessions/cash-sessions.controller';
import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import { listCashSessionsQuerySchema, openCashSessionSchema } from '../src/schemas';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import { AuthUser } from '../src/types';
import { db } from '../src/utils/firestore';

/**
 * SPEC 63 — arqueo del fondo heredado al abrir turno. El cajero que abre cuenta
 * el efectivo; la diferencia contra lo heredado queda en su turno y en el
 * anterior (no en su corte), el Z parte de lo contado y el autocierre queda
 * marcado para revisión.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

/** Turno anterior ya cerrado, con lo que se contó al cerrarlo. */
const closedSession = async (countedCashAmount: number, closedAgoMs = 60_000) => {
    const ref = await db().collection('cashSessions').add({
        openedBy: unique('cajero-a'),
        openingAmount: 0,
        expectedCashAmount: countedCashAmount,
        countedCashAmount,
        cashDifference: 0,
        summary: null,
        closedBy: 'x',
        openedAt: Timestamp.fromMillis(Date.now() - closedAgoMs - 3_600_000),
        closedAt: Timestamp.fromMillis(Date.now() - closedAgoMs),
    });
    return ref.id;
};

const sessionDoc = async (id: string) =>
    (await db().collection('cashSessions').doc(id).get()).data()!;

const openingAudits = async (sessionId: string) =>
    (await db().collection('auditLogs')
        .where('entityId', '==', sessionId)
        .where('action', '==', 'cash.opening_difference')
        .get()).docs.map((doc) => doc.data());

const cashierUser = (uid: string) => ({
    uid,
    role: { slug: 'cashier' },
    permissions: [{ area: 'pos', level: 'write' }],
} as unknown as AuthUser);

describe('SPEC 63 — openCashSessionSchema', () => {
    it('acepta el arqueo opcional y sigue aceptando un POS anterior', () => {
        expect(openCashSessionSchema.parse({ openingAmount: 500 })).toEqual({ openingAmount: 500 });
        const parsed = openCashSessionSchema.parse({
            openingAmount: 450,
            openingCounted: 450,
            inheritedFloat: -20,
            openingNote: '  Faltaban billetes  ',
        });
        expect(parsed).toMatchObject({
            openingCounted: 450,
            inheritedFloat: -20,
            openingNote: 'Faltaban billetes',
        });
    });

    it('rechaza un contado negativo', () => {
        expect(openCashSessionSchema.safeParse({ openingAmount: 0, openingCounted: -1 }).success)
            .toBe(false);
    });

    it('needsReview en el query es booleano de texto', () => {
        expect(listCashSessionsQuerySchema.parse({ needsReview: 'true' }).needsReview).toBe(true);
        expect(listCashSessionsQuerySchema.parse({ needsReview: 'false' }).needsReview)
            .toBe(false);
        expect(listCashSessionsQuerySchema.safeParse({ needsReview: 'si' }).success).toBe(false);
    });
});

describe('SPEC 63 — apertura con arqueo', () => {
    it('abrir con un contado distinto audita y marca el turno anterior', async () => {
        const previousId = await closedSession(500);
        const cajero = unique('cajero-b');
        const controller = new CashSessionsController();
        const { data: session } = await controller.open(
            openCashSessionSchema.parse({
                openingAmount: 450,
                openingCounted: 450,
                inheritedFloat: 500,
                openingNote: 'Faltaban 50 pesos',
            }),
            cashierUser(cajero),
        );

        expect(session).toMatchObject({
            openingAmount: 450,
            openingCounted: 450,
            inheritedFloat: 500,
            openingDifference: -50,
            openingNote: 'Faltaban 50 pesos',
        });
        expect(session).not.toHaveProperty('previousSessionId');
        expect((await sessionDoc(previousId)).followingOpeningDifference).toBe(-50);

        const audits = await openingAudits(session.id);
        expect(audits).toHaveLength(1);
        expect(audits[0].userId).toBe(cajero);
        expect(audits[0].metadata).toMatchObject({
            openingCounted: 450,
            inheritedFloat: 500,
            openingDifference: -50,
            openingNote: 'Faltaban 50 pesos',
            previousSessionId: previousId,
        });
    });

    it('con varias cajas marca el cierre cuyo conteo es el fondo heredado', async () => {
        const sameDrawer = await closedSession(800, 10 * 60_000);
        const otherDrawer = await closedSession(123, 60_000);
        const session = await cashSessionsService.openSession(unique('cajero'), 790, {
            openingCounted: 790,
            inheritedFloat: 800,
        });
        expect(session.openingDifference).toBe(-10);
        expect((await sessionDoc(sameDrawer)).followingOpeningDifference).toBe(-10);
        expect((await sessionDoc(otherDrawer)).followingOpeningDifference).toBeUndefined();
    });

    it('contado igual a lo heredado: sin auditoría ni marca', async () => {
        const previousId = await closedSession(300);
        const session = await cashSessionsService.openSession(unique('cajero'), 300, {
            openingCounted: 300,
            inheritedFloat: 300,
        });
        expect(session.openingDifference).toBe(0);
        expect(await openingAudits(session.id)).toHaveLength(0);
        expect((await sessionDoc(previousId)).followingOpeningDifference).toBeUndefined();
    });

    it('POS anterior sin openingCounted: comportamiento de siempre', async () => {
        const session = await cashSessionsService.openSession(unique('cajero'), 250);
        const stored = await sessionDoc(session.id);
        expect(stored.openingAmount).toBe(250);
        for (const field of ['openingCounted', 'inheritedFloat', 'openingDifference']) {
            expect(stored).not.toHaveProperty(field);
        }
        expect(await openingAudits(session.id)).toHaveLength(0);
    });

    it('primer turno de la caja (sin heredado): fondo = contado, sin diferencia', async () => {
        const session = await cashSessionsService.openSession(unique('cajero'), 100, {
            openingCounted: 100,
        });
        expect(session.openingCounted).toBe(100);
        expect(session).not.toHaveProperty('openingDifference');
        expect(await openingAudits(session.id)).toHaveLength(0);
    });

    it('el Z del turno nuevo usa openingCounted, no lo heredado', async () => {
        const cajero = unique('cajero');
        // `openingAmount` distinto a propósito: manda lo contado.
        const session = await cashSessionsService.openSession(cajero, 999, {
            openingCounted: 420,
            inheritedFloat: 400,
        });
        expect(session.openingAmount).toBe(420);

        const preview = await cashSessionsService.getSessionSummary(session.id, cajero, 'cashier');
        expect(preview.expectedCashAmount).toBe(420);

        const { session: closed, html } = await cashSessionsService.closeSession(
            session.id,
            cajero,
            'cashier',
            420,
        );
        expect(closed.expectedCashAmount).toBe(420);
        expect(closed.cashDifference).toBe(0);
        expect(html).toContain('420.00');
    });
});

describe('SPEC 63 — autocierre por revisar', () => {
    it('el autocierre marca autoClosed y needsReview, y el filtro los lista', async () => {
        const cajero = unique('cajero');
        const session = await cashSessionsService.openSession(cajero, 200);
        await db().collection('cashSessions').doc(session.id).update({
            openedAt: Timestamp.fromMillis(Date.now() - 2 * 24 * 3600 * 1000),
        });
        await cashSessionsService.closeSession(session.id, cajero, 'cashier', 200, {
            autoClosedByExpiry: true,
        });
        const stored = await sessionDoc(session.id);
        expect(stored.autoClosed).toBe(true);
        expect(stored.needsReview).toBe(true);

        // Un cierre normal no se marca.
        const normal = await cashSessionsService.openSession(cajero, 200);
        await cashSessionsService.closeSession(normal.id, cajero, 'cashier', 200);
        expect(await sessionDoc(normal.id)).not.toHaveProperty('needsReview');

        // Autocierre anterior a la marca: también por revisar.
        const legacy = await cashSessionsRepo.createCashSession({
            openedBy: cajero,
            openingAmount: 0,
            expectedCashAmount: 0,
            countedCashAmount: 0,
            cashDifference: 0,
            closedBy: cajero,
            closedAt: Timestamp.now(),
            autoClosedByExpiry: true,
        });

        const from = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
        const controller = new CashSessionsController();
        const pending = await controller.list(
            listCashSessionsQuerySchema.parse({ from, openedBy: cajero, needsReview: 'true' }),
        );
        expect(pending.data.map((item) => item.id).sort())
            .toEqual([session.id, legacy.id].sort());
        const rest = await controller.list(
            listCashSessionsQuerySchema.parse({ from, openedBy: cajero, needsReview: 'false' }),
        );
        expect(rest.data.map((item) => item.id)).toEqual([normal.id]);
    });
});
