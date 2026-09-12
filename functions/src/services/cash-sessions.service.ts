import { EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION } from '../constants/expenses';
import {
    CashAdjustmentStatus,
    CashReading,
    CashMethodTotals,
    CashMovement,
    CashMovementTotals,
    CashReturnTotals,
    CashSession,
    CashSessionSummary,
    ExpenseCategory,
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
import { ListMeta, buildListMeta, parsePagination } from '../utils/pagination';
import * as usersRepo from '../repositories/users.repository';

const emptyMethod = (): CashMethodTotals => ({ count: 0, total: 0 });
const emptyMovement = (): CashMovementTotals => ({ count: 0, total: 0 });

/**
 * Corte del turno.
 *
 * El cajón es **uno solo**, pero la farmacia mira dos cortes: el de mercancía y
 * el de servicios. Por eso `expectedCashAmount` sigue significando lo de siempre
 * —efectivo esperado de farmacia— y el de servicios viaja aparte en
 * `expectedServicesCashAmount`; el esperado físico del cajón es la suma.
 *
 * El fondo inicial es de farmacia y los movimientos (depósitos, retiros, gastos)
 * van íntegros a farmacia: servicios abre en 0.
 */
const buildSummary = (
    openingAmount: number,
    sales: cashSessionsRepo.SessionSaleRow[],
    movements: CashMovement[],
    returns: SaleReturn[],
): {
    summary: CashSessionSummary;
    expectedCashAmount: number;
    expectedServicesCashAmount: number;
    cashInDrawerNet: number;
} => {
    const byMethod = {
        cash: emptyMethod(),
        card: emptyMethod(),
        transfer: emptyMethod(),
        mixed: emptyMethod(),
    };
    const servicesByMethod = {
        cash: emptyMethod(),
        card: emptyMethod(),
        transfer: emptyMethod(),
        mixed: emptyMethod(),
    };

    let salesCount = 0;
    let voidedCount = 0;
    let grandTotal = 0;
    let cashInDrawerNet = 0;

    let servicesCount = 0;
    let servicesVoidedCount = 0;
    let servicesTotal = 0;
    let servicesCommissionTotal = 0;
    let servicesCashInDrawer = 0;
    let sawServices = false;

    for (const sale of sales) {
        if (sale.hasServices) {
            sawServices = true;
        }
        if (sale.voidedAt) {
            voidedCount += 1;
            if (sale.hasServices) {
                // Una venta anulada no infla ni el total de servicios ni las
                // comisiones ni el efectivo esperado: solo se cuenta.
                servicesVoidedCount += 1;
            }
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
            // Reparto "servicios primero" ya congelado en la venta. En las ventas
            // anteriores a los servicios `pharmacyCashAmount` cae al default de
            // compatibilidad (`cashAmount`, o recibido − cambio), así que el
            // efectivo esperado sale idéntico a como salía antes.
            cashInDrawerNet += sale.pharmacyCashAmount;
            servicesCashInDrawer += sale.servicesCashAmount;
        }
        if (sale.hasServices) {
            servicesCount += 1;
            servicesTotal += sale.servicesTotal;
            servicesCommissionTotal += sale.commissionTotal;
            if (servicesByMethod[method]) {
                servicesByMethod[method].count += 1;
                servicesByMethod[method].total += sale.servicesTotal;
            }
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

    // Redondeo a centavos: el corte se suma partida por partida en coma flotante y
    // sin esto salen cifras tipo 439.99999999999994 en pantalla y en el ticket.
    const round = (value: number): number => Math.round(value * 100) / 100;
    // El de farmacia se quedó sin redondear cuando se añadió el de servicios: la
    // rama nueva pasó por `round` y la vieja no. `expectedCashAmount` es lo que el
    // cajero compara contra el efectivo que cuenta a mano, así que una fracción de
    // centavo aquí es un descuadre que nadie puede cerrar: el cajón no tiene
    // milésimas.
    const cashInDrawer = round(openingAmount + cashInDrawerNet);
    return {
        expectedCashAmount: cashInDrawer,
        expectedServicesCashAmount: round(servicesCashInDrawer),
        cashInDrawerNet: round(cashInDrawerNet),
        summary: {
            salesCount,
            voidedCount,
            returns: { ...returnTotals, total: round(returnTotals.total), cashTotal: round(returnTotals.cashTotal) },
            byMethod,
            movements: movementTotals,
            grandTotal: round(grandTotal - returnTotals.total),
            cashInDrawer,
            // El bloque solo existe si el turno vio servicios: un corte de un turno
            // sin ellos queda **byte a byte** como el de antes.
            ...(sawServices
                ? {
                    services: {
                        count: servicesCount,
                        voidedCount: servicesVoidedCount,
                        byMethod: servicesByMethod,
                        total: round(servicesTotal),
                        commissionTotal: round(servicesCommissionTotal),
                        cashInDrawer: round(servicesCashInDrawer),
                    },
                }
                : {}),
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
): Promise<{
    session: CashSession;
    summary: CashSessionSummary;
    expectedCashAmount: number;
    /** Esperado de la rama de servicios; el del cajón es la suma de los dos. */
    expectedServicesCashAmount: number;
}> => {
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
    const { summary, expectedCashAmount, expectedServicesCashAmount } = buildSummary(
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
            expectedServicesCashAmount:
                session.expectedServicesCashAmount ?? expectedServicesCashAmount,
        };
    }

    return { session, summary, expectedCashAmount, expectedServicesCashAmount };
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
    expectedServicesCashAmount: number;
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
    const { summary, expectedCashAmount, expectedServicesCashAmount } = buildSummary(
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
        expectedServicesCashAmount,
        issuedBy: userId,
        issuedAt: new Date(),
        width: options.width ?? 58,
    });

    return { session, summary, expectedCashAmount, expectedServicesCashAmount, reading, html };
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
    options: { width?: ReceiptWidth; autoClosedByExpiry?: boolean } = {},
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
    const { summary, expectedCashAmount, expectedServicesCashAmount } = buildSummary(
        session.openingAmount,
        sales,
        movements,
        returns,
    );
    /**
     * El cajón es **uno**: el cajero cuenta el efectivo una sola vez y hay una
     * sola diferencia. Los dos esperados son informativos, así que el arqueo va
     * contra su **suma** —no hay segundo conteo ni segunda diferencia.
     *
     * Se redondea a centavos ANTES de comparar: en coma flotante
     * `500.01 - 500` da 0.009999999999990905, que no pasa el `>= 0.01` y dejaba
     * un centavo real de faltante cerrando el turno como si cuadrara. Además
     * evita persistir e imprimir diferencias tipo -39.999999999.
     */
    const expectedDrawerAmount = expectedCashAmount + expectedServicesCashAmount;
    const cashDifference = Math.round((countedCashAmount - expectedDrawerAmount) * 100) / 100;
    const autoClosedByExpiry = options.autoClosedByExpiry ?? false;
    // Un cierre automático a las 24:00 nunca genera ajuste pendiente: no hay
    // cajero presente para explicar la diferencia, y forzar una aprobación de
    // admin sobre un cierre que nadie autorizó en el momento no tiene sentido —
    // el backend ya recalculó `expectedCashAmount` de forma autoritativa, así
    // que cualquier pequeña discrepancia local queda absorbida silenciosamente.
    const hasPendingAdjustment = !autoClosedByExpiry && Math.abs(cashDifference) >= 0.01;

    const closed = await cashSessionsRepo.closeCashSession(id, {
        closedBy: userId,
        countedCashAmount,
        expectedCashAmount,
        expectedServicesCashAmount,
        cashDifference,
        summary,
        hasPendingAdjustment,
        adjustmentStatus: hasPendingAdjustment ? 'pending' : null,
        autoClosedByExpiry,
    });

    // Un corte que no cuadra es el primer síntoma de faltante: queda en bitácora,
    // y además el turno queda marcado como pendiente de revisión de un admin
    // (`hasPendingAdjustment`) — antes solo se auditaba, sin dejar un estado
    // que el módulo de auditoría pudiera resolver.
    if (Math.abs(cashDifference) >= 0.01) {
        await recordAudit({
            action: 'cash_session.closed_with_difference',
            entity: 'cashSession',
            entityId: id,
            summary: `Corte de caja con diferencia de ${cashDifference.toFixed(2)} ` +
                `(esperado ${expectedDrawerAmount.toFixed(2)}, ` +
                `contado ${countedCashAmount.toFixed(2)})`,
            userId,
            roleSlug,
            metadata: {
                expectedCashAmount,
                expectedServicesCashAmount,
                countedCashAmount,
                cashDifference,
                salesCount: summary.salesCount,
                returns: summary.returns ?? null,
                autoClosedByExpiry,
            },
        });
    }

    const html = renderCashReportHtml({
        kind: 'Z',
        folio: null,
        session: closed,
        summary,
        expectedCashAmount,
        expectedServicesCashAmount,
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
    input: {
        type: CashMovement['type'];
        amount: number;
        reason: string;
        category?: ExpenseCategory;
        description?: string;
        createdByLabel?: string;
    },
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
        category: input.category,
        description: input.description?.trim() || undefined,
        createdBy: userId,
        createdByLabel: input.createdByLabel?.trim() || undefined,
    });
};

/**
 * Corrige un gasto ya registrado del turno.
 *
 * Se permite **solo mientras el turno sigue abierto**: el gasto entra en el
 * efectivo esperado del corte, así que corregir una cifra después de cerrar
 * cambiaría un arqueo ya firmado. Cerrado el turno, la vía es el ajuste que
 * aprueba un admin, no la edición.
 *
 * Tampoco se admite cambiar el tipo: un gasto no se convierte en depósito. Para
 * eso se anula y se registra el correcto.
 */
export const updateExpense = async (
    movementId: string,
    userId: string,
    roleSlug: string,
    patch: {
        amount?: number;
        reason?: string;
        category?: ExpenseCategory;
        description?: string;
    },
): Promise<CashMovement> => {
    const movement = await cashMovementsRepo.getMovementById(movementId);
    if (!movement) {
        throw notFound('Movimiento de caja');
    }
    if (movement.type !== 'expense') {
        throw badRequest('Solo se pueden corregir gastos');
    }
    if (!movement.cashSessionId) {
        throw badRequest('El movimiento no pertenece a un turno de caja');
    }

    const session = await cashSessionsRepo.getCashSessionById(movement.cashSessionId);
    if (!session) {
        throw notFound('Turno de caja');
    }
    if (session.closedAt) {
        throw badRequest('El turno de caja ya está cerrado: el gasto no se puede corregir');
    }
    assertCanAccessSession(session, userId, roleSlug);

    if (patch.amount !== undefined && patch.amount <= 0) {
        throw badRequest('El monto debe ser mayor a cero');
    }
    if (patch.reason !== undefined && !patch.reason.trim()) {
        throw badRequest('El motivo es requerido');
    }

    // La descripción obligatoria se valida contra la categoría **resultante**,
    // no contra la que traía: cambiar a "Insumos" sin describir dejaría un gasto
    // que el alta jamás habría aceptado.
    const category = patch.category ?? movement.category ?? undefined;
    const description = patch.description ?? movement.description ?? undefined;
    if (
        category !== undefined &&
        EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(category) &&
        !description?.trim()
    ) {
        throw badRequest('La descripción es requerida para esta categoría');
    }

    return cashMovementsRepo.updateMovement(movementId, {
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason.trim() } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.description !== undefined
            ? { description: patch.description.trim() || null }
            : {}),
    });
};

/**
 * Caja de la farmacia (solo admin): entrada o salida de efectivo que **puede ir
 * sin turno**. Si viene `cashSessionId`, el movimiento se cuelga de ese turno y
 * baja/sube su efectivo esperado como cualquier otro; si no, queda con
 * `cashSessionId: null` y no entra a ningún corte —`buildSummary` filtra por
 * sesión, así que los sueltos quedan fuera solos.
 *
 * A diferencia de `addMovement`, esta sí audita: sacar efectivo sin ticket que
 * lo respalde es exactamente lo que la bitácora existe para rastrear.
 */
export const addCashBoxMovement = async (
    userId: string,
    roleSlug: string,
    input: {
        type: 'deposit' | 'withdrawal';
        amount: number;
        reason: string;
        cashSessionId?: string;
    },
): Promise<CashMovement> => {
    let cashSessionId: string | null = null;
    if (input.cashSessionId) {
        const session = await cashSessionsRepo.getCashSessionById(input.cashSessionId);
        if (!session) {
            throw notFound('Turno de caja');
        }
        if (session.closedAt) {
            throw badRequest('El turno de caja ya está cerrado');
        }
        cashSessionId = session.id;
    }

    const movement = await cashMovementsRepo.createMovement({
        cashSessionId,
        type: input.type,
        amount: input.amount,
        reason: input.reason.trim(),
        createdBy: userId,
    });

    await recordAudit({
        action: 'cashMovement.created',
        entity: 'cashMovement',
        entityId: movement.id,
        summary: `${input.type === 'deposit' ? 'Entrada' : 'Salida'} de efectivo por ` +
            `${input.amount.toFixed(2)}: ${input.reason.trim()}` +
            (cashSessionId ? ' (aplicada al turno abierto)' : ' (caja de farmacia, sin turno)'),
        userId,
        roleSlug,
        metadata: { type: input.type, amount: input.amount, cashSessionId },
    });

    return movement;
};

/**
 * Auditoría global (solo admin): todas las cajas, con filtros opcionales.
 * Pagina de verdad (`page` + `meta`): antes solo aceptaba `limit`, así que los
 * cortes más allá del tope no eran alcanzables desde ninguna pantalla.
 */
export const listCashSessions = async (filters: {
    from?: string;
    to?: string;
    openedBy?: string;
    adjustmentStatus?: CashAdjustmentStatus;
    page?: number;
    limit?: number;
}): Promise<{ items: CashSessionWithUsers[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await cashSessionsRepo.listCashSessions({ ...filters, page, limit });
    return { items: await attachUserLabels(items), meta: buildListMeta(page, limit, total) };
};

/**
 * Corte con el nombre de quien lo abrió y lo cerró. `openedBy`/`closedBy` son
 * uids: una pantalla de auditoría que solo muestra `BigLX3wed1Peu...` no permite
 * auditar nada, porque el admin no sabe de quién es esa caja.
 */
export type CashSessionWithUsers = CashSession & {
    openedByLabel: string | null;
    closedByLabel: string | null;
};

/**
 * Resuelve los uids de la página en un solo lote. `getUserProfile` cachea por
 * proceso, así que un listado de un mismo cajero cuesta una lectura, no una por
 * renglón.
 */
const attachUserLabels = async (sessions: CashSession[]): Promise<CashSessionWithUsers[]> => {
    const uids = [
        ...new Set(
            sessions.flatMap((session) => [session.openedBy, session.closedBy]).filter(
                (uid): uid is string => Boolean(uid),
            ),
        ),
    ];
    const profiles = new Map(
        await Promise.all(
            uids.map(async (uid) => [uid, await usersRepo.getUserProfile(uid)] as const),
        ),
    );
    const labelOf = (uid: string | null): string | null => {
        if (!uid) {
            return null;
        }
        const profile = profiles.get(uid);
        return profile?.displayName || profile?.email || null;
    };

    return sessions.map((session) => ({
        ...session,
        openedByLabel: labelOf(session.openedBy),
        closedByLabel: labelOf(session.closedBy),
    }));
};

/** Auditoría global (solo admin): depósitos/retiros/gastos de todas las cajas. */
export const listAllMovements = async (filters: {
    from?: string;
    to?: string;
    type?: CashMovement['type'];
    category?: ExpenseCategory;
    cashSessionId?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: CashMovement[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await cashMovementsRepo.listAllMovements({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

/**
 * Un admin aprueba o rechaza el ajuste de un turno ya cerrado con diferencia.
 * Solo tiene sentido sobre un turno con ajuste realmente pendiente: aprobar
 * dos veces, o aprobar uno que nunca tuvo diferencia, no debe ser posible.
 */
export const reviewAdjustment = async (
    id: string,
    reviewerId: string,
    decision: 'approved' | 'rejected',
    note?: string,
): Promise<CashSession> => {
    const session = await cashSessionsRepo.getCashSessionById(id);
    if (!session) {
        throw notFound('Turno de caja');
    }
    if (!session.hasPendingAdjustment || session.adjustmentStatus !== 'pending') {
        throw badRequest('Este turno no tiene un ajuste pendiente de revisión');
    }
    const reviewed = await cashSessionsRepo.reviewAdjustment(id, {
        adjustmentStatus: decision,
        adjustmentReviewedBy: reviewerId,
        adjustmentNote: note?.trim() || null,
    });
    await recordAudit({
        action: 'cash_session.adjustment_reviewed',
        entity: 'cashSession',
        entityId: id,
        summary: `Ajuste de corte ${decision === 'approved' ? 'aprobado' : 'rechazado'} ` +
            `(diferencia ${session.cashDifference?.toFixed(2) ?? '?'})`,
        userId: reviewerId,
        roleSlug: 'admin',
        metadata: { decision, note: note ?? null, cashDifference: session.cashDifference ?? null },
    });
    return reviewed;
};
