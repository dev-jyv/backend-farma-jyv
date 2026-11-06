import { Timestamp } from 'firebase-admin/firestore';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import { db } from '../src/utils/firestore';

/**
 * SPEC 53, punto 6 — el resumen del turno incluye `unreconciledCash`: el efectivo
 * de las ventas no conciliadas **pendientes** de ese turno. Es dinero que está en
 * el cajón sin venta registrada; no entra al esperado.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Venta no conciliada escrita directo en la colección (la forma de su alta la
 * cambia otra parte de SPEC 53; aquí solo importa lo que lee el corte).
 */
const unreconciled = async (input: {
    cashSessionId: string | null;
    total: number;
    payload: Record<string, unknown>;
    resolved?: boolean;
}) => {
    await db().collection('unreconciledSales').doc(unique('local')).set({
        localId: unique('local'),
        localFolio: null,
        reason: 'Stock insuficiente',
        total: input.total,
        payload: input.payload,
        cashierId: 'cajero-53',
        cashSessionId: input.cashSessionId,
        occurredAt: null,
        resolvedAt: input.resolved ? Timestamp.now() : null,
        resolvedBy: input.resolved ? 'admin' : null,
        createdAt: Timestamp.now(),
    });
};

describe('SPEC 53 — unreconciledCash en el resumen del turno', () => {
    it('suma el efectivo de las pendientes del turno, sin tocar el esperado', async () => {
        const cajero = unique('cajero');
        const session = await cashSessionsService.openSession(cajero, 500);
        const other = await cashSessionsService.openSession(unique('otro'), 0);

        await unreconciled({
            cashSessionId: session.id,
            total: 100.1,
            payload: { paymentMethod: 'cash', amountReceived: 200 },
        });
        await unreconciled({
            cashSessionId: session.id,
            total: 300,
            payload: { paymentMethod: 'mixed', cardAmount: 200.05, amountReceived: 100 },
        });
        // Mixto sin reparto (venta con order Point): cuenta lo recibido, tope el total.
        await unreconciled({
            cashSessionId: session.id,
            total: 80,
            payload: { paymentMethod: 'mixed', amountReceived: 30 },
        });
        await unreconciled({
            cashSessionId: session.id,
            total: 50,
            payload: { paymentMethod: 'card' },
        });
        // Ya resuelta: no cuenta.
        await unreconciled({
            cashSessionId: session.id,
            total: 70,
            payload: { paymentMethod: 'cash' },
            resolved: true,
        });
        // De otro turno o sin turno: no cuenta.
        await unreconciled({
            cashSessionId: other.id,
            total: 999,
            payload: { paymentMethod: 'cash' },
        });
        await unreconciled({ cashSessionId: null, total: 999, payload: { paymentMethod: 'cash' } });

        // 100.10 + (300 − 200.05) + 30 = 230.05
        const result = await cashSessionsService.getSessionSummary(session.id, cajero, 'cashier');
        expect(result.summary.unreconciledCash).toBe(230.05);
        expect(result.expectedCashAmount).toBe(500);
        expect(result.summary.cashInDrawer).toBe(500);

        const x = await cashSessionsService.buildXReport(session.id, cajero, 'cashier');
        expect(x.summary.unreconciledCash).toBe(230.05);
        expect(x.html).toContain('No conciliadas (efectivo)');

        const closed = await cashSessionsService.closeSession(session.id, cajero, 'cashier', 500);
        expect(closed.summary.unreconciledCash).toBe(230.05);
        expect(closed.session.cashDifference).toBe(0);

        // Una que llega después del cierre aparece al consultar el turno cerrado.
        await unreconciled({
            cashSessionId: session.id,
            total: 19.95,
            payload: { paymentMethod: 'cash' },
        });
        const after = await cashSessionsService.getSessionSummary(session.id, cajero, 'cashier');
        expect(after.summary.unreconciledCash).toBe(250);
        expect(after.summary.salesCount).toBe(closed.summary.salesCount);
    });

    it('sin no conciliadas el resumen trae 0 y el ticket no cambia', async () => {
        const cajero = unique('cajero');
        const session = await cashSessionsService.openSession(cajero, 100);
        const x = await cashSessionsService.buildXReport(session.id, cajero, 'cashier');
        expect(x.summary.unreconciledCash).toBe(0);
        expect(x.html).not.toContain('No conciliadas');
    });
});
