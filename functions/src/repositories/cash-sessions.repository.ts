import { CashSession, CashSessionSummary } from '../types';
import { db, now } from '../utils/firestore';
import { paginate } from '../utils/pagination';

const collection = () => db().collection('cashSessions');

export const createCashSession = async (
    data: Omit<CashSession, 'id' | 'openedAt'>,
): Promise<CashSession> => {
    const payload = { ...data, openedAt: now() };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const getCashSessionById = async (id: string): Promise<CashSession | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return { id: doc.id, ...doc.data() } as CashSession;
};

export const getOpenSessionForUser = async (userId: string): Promise<CashSession | null> => {
    const snapshot = await collection()
        .where('openedBy', '==', userId)
        .where('closedAt', '==', null)
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as CashSession;
};

interface CloseCashSessionData {
    closedBy: string;
    countedCashAmount: number;
    /** Esperado de farmacia. */
    expectedCashAmount: number;
    /** Esperado de servicios; la diferencia se calcula contra la suma de ambos. */
    expectedServicesCashAmount?: number;
    cashDifference: number;
    summary: CashSessionSummary;
    hasPendingAdjustment?: boolean;
    adjustmentStatus?: 'pending' | null;
    autoClosedByExpiry?: boolean;
}

export const closeCashSession = async (
    id: string,
    data: CloseCashSessionData,
): Promise<CashSession> => {
    const ref = collection().doc(id);
    const timestamp = now();
    await ref.update({
        closedAt: timestamp,
        closedBy: data.closedBy,
        countedCashAmount: data.countedCashAmount,
        expectedCashAmount: data.expectedCashAmount,
        expectedServicesCashAmount: data.expectedServicesCashAmount ?? 0,
        cashDifference: data.cashDifference,
        summary: data.summary,
        hasPendingAdjustment: data.hasPendingAdjustment ?? false,
        adjustmentStatus: data.adjustmentStatus ?? null,
        autoClosedByExpiry: data.autoClosedByExpiry ?? false,
    });
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as CashSession;
};

interface ListCashSessionsFilters {
    from?: string;
    to?: string;
    openedBy?: string;
    adjustmentStatus?: 'pending' | 'approved' | 'rejected';
    page: number;
    limit: number;
}

/**
 * Sin `from`, la auditoría se acota a los últimos 90 días. Antes se leía hasta
 * el tope de `limit` sobre TODO el histórico: los cortes viejos eran
 * inalcanzables (no había página 2) y aun así se pagaban sus lecturas.
 */
const DEFAULT_AUDIT_DAYS = 90;

const defaultFrom = (): Date =>
    new Date(Date.now() - DEFAULT_AUDIT_DAYS * 24 * 60 * 60 * 1000);

/**
 * Auditoría global (solo admin): todas las cajas, no solo la propia. Firestore
 * no permite `where` en más de un campo de rango a la vez con `orderBy`
 * distinto, así que el rango de fecha filtra sobre `openedAt` y el resto se
 * aplica en memoria — el volumen de turnos por farmacia es bajo, no amerita
 * un índice compuesto por cada combinación de filtros.
 */
export const listCashSessions = async (
    filters: ListCashSessionsFilters,
): Promise<{ items: CashSession[]; total: number }> => {
    let query = collection().orderBy('openedAt', 'desc') as FirebaseFirestore.Query;
    query = query.where('openedAt', '>=', filters.from ? new Date(filters.from) : defaultFrom());
    if (filters.to) {
        query = query.where('openedAt', '<=', new Date(filters.to));
    }
    const snapshot = await query.get();
    let sessions = snapshot.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() }) as CashSession,
    );
    if (filters.openedBy) {
        sessions = sessions.filter((session) => session.openedBy === filters.openedBy);
    }
    if (filters.adjustmentStatus) {
        sessions = sessions.filter(
            (session) => session.adjustmentStatus === filters.adjustmentStatus,
        );
    }
    // El recorte va DESPUÉS de los filtros en memoria: paginar antes devolvía
    // páginas de tamaño irregular y un total que no era el del filtro aplicado.
    return paginate(sessions, filters.page, filters.limit);
};

interface ReviewAdjustmentData {
    adjustmentStatus: 'approved' | 'rejected';
    adjustmentReviewedBy: string;
    adjustmentNote: string | null;
}

export const reviewAdjustment = async (
    id: string,
    data: ReviewAdjustmentData,
): Promise<CashSession> => {
    const ref = collection().doc(id);
    await ref.update({
        adjustmentStatus: data.adjustmentStatus,
        adjustmentReviewedBy: data.adjustmentReviewedBy,
        adjustmentReviewedAt: now(),
        adjustmentNote: data.adjustmentNote,
        hasPendingAdjustment: false,
    });
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as CashSession;
};

export interface SessionSaleRow {
    paymentMethod: string;
    amountReceived: number | null;
    change: number | null;
    /** Efectivo aplicado a la venta; ausente en ventas anteriores al split mixto. */
    cashAmount: number | null;
    total: number;
    voidedAt: unknown | null;
    /** `true` si la venta cobró algún servicio; falso en toda venta histórica. */
    hasServices: boolean;
    /** Parte de mercancía del total. En una venta histórica es el total completo. */
    pharmacyTotal: number;
    /** Parte de servicios del total; 0 en una venta histórica. */
    servicesTotal: number;
    /** Efectivo de mercancía. En una venta histórica es todo el efectivo. */
    pharmacyCashAmount: number;
    /** Efectivo de servicios; 0 en una venta histórica. */
    servicesCashAmount: number;
    /** Comisiones de la venta; 0 en una venta histórica. */
    commissionTotal: number;
}

/**
 * Ventas del turno para el corte.
 *
 * Los campos de la partición farmacia/servicios llevan **defaults de
 * compatibilidad**: una venta anterior a los servicios no los tiene, y con
 * `pharmacyTotal ?? total` y `servicesTotal ?? 0` se comporta como 100 %
 * farmacia. Así un turno de ventas viejas da exactamente el mismo corte que
 * antes de existir la rama de servicios.
 */
export const listSalesForSession = async (cashSessionId: string): Promise<SessionSaleRow[]> => {
    const snapshot = await db()
        .collection('sales')
        .where('cashSessionId', '==', cashSessionId)
        .get();
    return snapshot.docs.map((doc) => {
        const data = doc.data();
        const cashAmount = (data.cashAmount as number | null | undefined) ?? null;
        const total = data.total as number;
        return {
            paymentMethod: data.paymentMethod as string,
            amountReceived: data.amountReceived as number | null,
            change: data.change as number | null,
            cashAmount,
            total,
            voidedAt: data.voidedAt ?? null,
            hasServices: (data.hasServices as boolean | undefined) ?? false,
            pharmacyTotal: (data.pharmacyTotal as number | undefined) ?? total,
            servicesTotal: (data.servicesTotal as number | undefined) ?? 0,
            pharmacyCashAmount: (data.pharmacyCashAmount as number | undefined) ??
                (cashAmount ??
                    ((data.amountReceived as number | null ?? 0) -
                        (data.change as number | null ?? 0))),
            servicesCashAmount: (data.servicesCashAmount as number | undefined) ?? 0,
            commissionTotal: (data.commissionTotal as number | undefined) ?? 0,
        };
    });
};
