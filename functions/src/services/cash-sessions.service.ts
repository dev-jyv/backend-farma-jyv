import {
    CashReading,
    CashMethodTotals,
    CashMovement,
    CashMovementTotals,
    CashReturnTotals,
    CashSession,
    CashSessionSummary,
    PaymentMethod,
    SaleReturn,
} from '../types';
import { badRequest, forbidden, notFound } from '../utils/errors';
import * as cashSessionsRepo from '../repositories/cash-sessions.repository';
import * as cashMovementsRepo from '../repositories/cash-movements.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as readingsRepo from '../repositories/cash-readings.repository';
import { renderCashReportHtml } from './cash-reports.service';
import { ReceiptWidth } from './receipts.service';
import { db, now } from '../utils/firestore';
import { recordAudit } from './audit.service';

const emptyMethod = (): CashMethodTotals => ({ count: 0, total: 0 });
const emptyMovement = (): CashMovementTotals => ({ count: 0, total: 0 });

const buildSummary = (
    openingAmount: number,
    sales: cashSessionsRepo.SessionSaleRow[],
    movements: CashMovement[],
    returns: SaleReturn[],
): { summary: CashSessionSummary; expectedCashAmount: number; cashInDrawerNet: number } => {
    const byMethod = {
        cash: emptyMethod(),
        card: emptyMethod(),
        transfer: emptyMethod(),
        mixed: emptyMethod(),
    };

    let salesCount = 0;
    let voidedCount = 0;
    let grandTotal = 0;
    let cashInDrawerNet = 0;

    for (const sale of sales) {
        if (sale.voidedAt) {
            voidedCount += 1;
            continue;
        }
        salesCount += 1;
        grandTotal += sale.total;
        const method = sale.paymentMethod as PaymentMethod;
        if (byMethod[method]) {
            byMethod[method].count += 1;
            byMethod[method].total += sale.total;
        }
        if (method === 'cash' || method === 'mixed') {
            // `cashAmount` es la parte del total pagada en efectivo. En ventas
            // anteriores al split mixto se reconstruye como recibido − cambio.
            cashInDrawerNet += sale.cashAmount ??
                ((sale.amountReceived ?? 0) - (sale.change ?? 0));
        }
    }

    const movementTotals = {
        deposits: emptyMovement(),
        withdrawals: emptyMovement(),
        expenses: emptyMovement(),
    };

    for (const movement of movements) {
        if (movement.type === 'deposit') {
            movementTotals.deposits.count += 1;
            movementTotals.deposits.total += movement.amount;
            cashInDrawerNet += movement.amount;
        } else if (movement.type === 'withdrawal') {
            movementTotals.withdrawals.count += 1;
            movementTotals.withdrawals.total += movement.amount;
            cashInDrawerNet -= movement.amount;
        } else {
            movementTotals.expenses.count += 1;
            movementTotals.expenses.total += movement.amount;
            cashInDrawerNet -= movement.amount;
        }
    }

    // Devoluciones: solo el efectivo sale del cajón; tarjeta y transferencia se
    // reembolsan por su propio canal y no afectan el conteo físico.
    const returnTotals: CashReturnTotals = { count: 0, total: 0, cashTotal: 0 };
    for (const saleReturn of returns) {
        returnTotals.count += 1;
        returnTotals.total += saleReturn.refundTotal;
        if (saleReturn.refundMethod === 'cash') {
            returnTotals.cashTotal += saleReturn.refundTotal;
            cashInDrawerNet -= saleReturn.refundTotal;
        }
    }

    const cashInDrawer = openingAmount + cashInDrawerNet;
    return {
        expectedCashAmount: cashInDrawer,
        cashInDrawerNet,
        summary: {
            salesCount,
            voidedCount,
            returns: returnTotals,
            byMethod,
            movements: movementTotals,
            grandTotal: grandTotal - returnTotals.total,
            cashInDrawer,
        },
    };
};

/**
 * Un turno de caja es de quien lo abrió: solo ese cajero (o un admin) puede
 * consultarlo, moverlo o cargarle ventas y devoluciones. Se exporta porque
 * `sales.service` y `sale-returns.service` deben aplicar la misma regla: sin ella
 * un cajero puede cargar efectivo al turno de otro y dejarle el faltante en su
 * corte. Acepta la forma mínima para poder llamarse con los datos del documento
 * ya leído dentro de una transacción, sin una lectura extra.
 */
export const assertCanAccessSession = (
    session: Pick<CashSession, 'openedBy'>,
    userId: string,
    roleSlug?: string | null,
): void => {
    if (session.openedBy !== userId && roleSlug !== 'admin') {
        throw forbidden(
            'Solo el cajero que abrió el turno o un administrador puede usarlo',
        );
    }
};

export const getCurrentSession = async (userId: string): Promise<CashSession | null> =>
    cashSessionsRepo.getOpenSessionForUser(userId);

export const openSession = async (userId: string, openingAmount: number): Promise<CashSession> => {
    const existing = await cashSessionsRepo.getOpenSessionForUser(userId);
    if (existing) {
        throw badRequest('Ya tienes un turno de caja abierto');
    }
    return cashSessionsRepo.createCashSession({
        openedBy: userId,
        openingAmount,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
    });
};

export const getSessionSummary = async (
    id: string,
    userId: string,
    roleSlug: string,
): Promise<{ session: CashSession; summary: CashSessionSummary; expectedCashAmount: number }> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    assertCanAccessSession(session, userId, roleSlug);

    const [sales, movements, returns] = await Promise.all([
        cashSessionsRepo.listSalesForSession(id),
        cashMovementsRepo.listMovementsForSession(id),
        returnsRepo.listReturnsForSession(id),
    ]);
    const { summary, expectedCashAmount } = buildSummary(
        session.openingAmount,
        sales,
        movements,
        returns,
    );

    if (session.closedAt && session.summary) {
        return {
            session,
            summary: session.summary,
            expectedCashAmount: session.expectedCashAmount ?? expectedCashAmount,
        };
    }

    return { session, summary, expectedCashAmount };
};

const X_READING_COUNTER_ID = 'cashReadings';

const buildReadingFolio = (sequence: number): string => `X-${String(sequence).padStart(6, '0')}`;

/**
 * Lectura X: foto del turno **sin cerrarlo**. `persist: false` es la vista previa
 * en pantalla; `persist: true` deja el renglón en `cashReadings` (control de quién
 * miró la caja y cuándo) y devuelve el folio para imprimir.
 */
export const buildXReport = async (
    id: string,
    userId: string,
    roleSlug: string,
    options: { persist?: boolean; width?: ReceiptWidth } = {},
): Promise<{
    session: CashSession;
    summary: CashSessionSummary;
    expectedCashAmount: number;
    reading: CashReading | null;
    html: string;
}> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    assertCanAccessSession(session, userId, roleSlug);
    if (session.closedAt) {
        throw badRequest('El turno de caja ya está cerrado: usa el corte Z');
    }

    const [sales, movements, returns] = await Promise.all([
        cashSessionsRepo.listSalesForSession(id),
        cashMovementsRepo.listMovementsForSession(id),
        returnsRepo.listReturnsForSession(id),
    ]);
    const { summary, expectedCashAmount } = buildSummary(
        session.openingAmount,
        sales,
        movements,
        returns,
    );

    let reading: CashReading | null = null;

    if (options.persist) {
        const firestore = db();
        const readingRef = firestore.collection('cashReadings').doc();
        const counterRef = firestore.collection('counters').doc(X_READING_COUNTER_ID);
        const timestamp = now();

        reading = await firestore.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);
            const nextSequence = (counterDoc.data()?.value as number | undefined ?? 0) + 1;
            const folio = buildReadingFolio(nextSequence);

            transaction.set(counterRef, { value: nextSequence }, { merge: true });
            const data = {
                folio,
                cashSessionId: id,
                summary,
                expectedCashAmount,
                createdBy: userId,
                createdAt: timestamp,
            };
            transaction.set(readingRef, data);
            return { id: readingRef.id, ...data };
        });
    }

    const html = renderCashReportHtml({
        kind: 'X',
        folio: reading?.folio ?? null,
        session,
        summary,
        expectedCashAmount,
        issuedBy: userId,
        issuedAt: new Date(),
        width: options.width ?? 58,
    });

    return { session, summary, expectedCashAmount, reading, html };
};

export const listXReadings = async (
    id: string,
    userId: string,
    roleSlug: string,
): Promise<CashReading[]> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    assertCanAccessSession(session, userId, roleSlug);
    return readingsRepo.listReadingsForSession(id);
};

export const closeSession = async (
    id: string,
    userId: string,
    roleSlug: string,
    countedCashAmount: number,
    options: { width?: ReceiptWidth } = {},
): Promise<{ session: CashSession; summary: CashSessionSummary; html: string }> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    if (session.closedAt) {
        throw badRequest('El turno de caja ya está cerrado');
    }
    assertCanAccessSession(session, userId, roleSlug);

    const [sales, movements, returns] = await Promise.all([
        cashSessionsRepo.listSalesForSession(id),
        cashMovementsRepo.listMovementsForSession(id),
        returnsRepo.listReturnsForSession(id),
    ]);
    const { summary, expectedCashAmount } = buildSummary(
        session.openingAmount,
        sales,
        movements,
        returns,
    );
    const cashDifference = countedCashAmount - expectedCashAmount;

    const closed = await cashSessionsRepo.closeCashSession(id, {
        closedBy: userId,
        countedCashAmount,
        expectedCashAmount,
        cashDifference,
        summary,
    });

    // Un corte que no cuadra es el primer síntoma de faltante: queda en bitácora.
    if (Math.abs(cashDifference) >= 0.01) {
        await recordAudit({
            action: 'cash_session.closed_with_difference',
            entity: 'cashSession',
            entityId: id,
            summary: `Corte de caja con diferencia de ${cashDifference.toFixed(2)} ` +
                `(esperado ${expectedCashAmount.toFixed(2)}, ` +
                `contado ${countedCashAmount.toFixed(2)})`,
            userId,
            roleSlug,
            metadata: {
                expectedCashAmount,
                countedCashAmount,
                cashDifference,
                salesCount: summary.salesCount,
                returns: summary.returns ?? null,
            },
        });
    }

    const html = renderCashReportHtml({
        kind: 'Z',
        folio: null,
        session: closed,
        summary,
        expectedCashAmount,
        countedCashAmount,
        cashDifference,
        issuedBy: userId,
        issuedAt: new Date(),
        width: options.width ?? 58,
    });

    return { session: closed, summary, html };
};

export const listMovements = async (
    id: string,
    userId: string,
    roleSlug: string,
): Promise<CashMovement[]> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    assertCanAccessSession(session, userId, roleSlug);
    return cashMovementsRepo.listMovementsForSession(id);
};

export const addMovement = async (
    id: string,
    userId: string,
    roleSlug: string,
    input: { type: CashMovement['type']; amount: number; reason: string },
): Promise<CashMovement> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    if (session.closedAt) {
        throw badRequest('El turno de caja ya está cerrado');
    }
    assertCanAccessSession(session, userId, roleSlug);
    if (input.amount <= 0) {
        throw badRequest('El monto debe ser mayor a cero');
    }
    if (!input.reason.trim()) {
        throw badRequest('El motivo es requerido');
    }
    return cashMovementsRepo.createMovement({
        cashSessionId: id,
        type: input.type,
        amount: input.amount,
        reason: input.reason.trim(),
        createdBy: userId,
    });
};
