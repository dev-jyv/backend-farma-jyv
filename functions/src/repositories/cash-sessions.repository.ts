import { CashSession, CashSessionSummary } from '../types';
import { badRequest } from '../utils/errors';
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

/**
 * Alta de turno **solo si el cajero no tiene otro abierto**, verificado dentro de la
 * misma transacción: con la lectura aparte, un doble toque o el reintento del POS
 * creaba dos turnos abiertos y las ventas se repartían entre dos cortes.
 */
export const createCashSessionIfNoneOpen = async (
    data: Omit<CashSession, 'id' | 'openedAt'>,
): Promise<CashSession & { previousSessionId?: string | null }> =>
    db().runTransaction(async (transaction) => {
        // Turno anterior (SPEC 63): solo hace falta si el arqueo de apertura no
        // cuadró. Se lee aquí, antes de cualquier escritura.
        const markPrevious = typeof data.openingDifference === 'number' &&
            Math.abs(data.openingDifference) >= 0.01;
        const [open, recentlyClosed] = await Promise.all([
            transaction.get(
                collection()
                    .where('openedBy', '==', data.openedBy)
                    .where('closedAt', '==', null)
                    .limit(1),
            ),
            markPrevious
                ? transaction.get(recentlyClosedQuery())
                : Promise.resolve(null),
        ]);
        if (!open.empty) {
            throw badRequest('Ya tienes un turno de caja abierto');
        }
        const payload = { ...data, openedAt: now() };
        const ref = collection().doc();
        transaction.create(ref, payload);

        const previous = recentlyClosed
            ? pickPreviousSession(recentlyClosed.docs, data.inheritedFloat)
            : null;
        if (previous) {
            transaction.update(previous.ref, {
                followingOpeningDifference: data.openingDifference,
            });
        }
        return {
            id: ref.id,
            ...payload,
            ...(markPrevious ? { previousSessionId: previous?.id ?? null } : {}),
        };
    });

/** Cierres que se consideran "el turno anterior" al abrir (SPEC 63). */
const PREVIOUS_SESSION_CANDIDATES = 5;

/**
 * Los últimos turnos cerrados. Los `closedAt: null` (abiertos) ordenan antes que
 * cualquier fecha, así que en orden descendente quedan al final.
 */
const recentlyClosedQuery = (): FirebaseFirestore.Query =>
    collection().orderBy('closedAt', 'desc').limit(PREVIOUS_SESSION_CANDIDATES);

/**
 * El backend no sabe de qué caja física viene el turno: "el anterior" es el
 * último cierre, salvo que entre los recientes haya uno cuyo conteo sea
 * exactamente el fondo heredado que mostró la caja (con varias cajas, ese es el
 * del mismo cajón).
 */
const pickPreviousSession = (
    docs: FirebaseFirestore.QueryDocumentSnapshot[],
    inheritedFloat: number | undefined,
): FirebaseFirestore.QueryDocumentSnapshot | null => {
    const closed = docs.filter((doc) => doc.data().closedAt);
    if (!closed.length) {
        return null;
    }
    const sameAmount = typeof inheritedFloat === 'number'
        ? closed.find((doc) => {
            const counted = doc.data().countedCashAmount;
            return typeof counted === 'number' &&
                Math.round(counted * 100) === Math.round(inheritedFloat * 100);
        })
        : undefined;
    return sameAmount ?? closed[0];
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

/**
 * Cierra el turno. Con `data` como función (SPEC 52), el resumen se arma
 * **dentro** de la transacción con las ventas del turno leídas por consulta
 * transaccional: una venta que confirma entre el cálculo previo y el cierre ya
 * no queda en el turno pero fuera del corte congelado. Si una venta se escribe
 * mientras tanto, Firestore reintenta el cierre y el resumen se rehace.
 */
export const closeCashSession = async (
    id: string,
    data: CloseCashSessionData | ((sales: SessionSaleRow[]) => CloseCashSessionData),
): Promise<CashSession> => {
    const ref = collection().doc(id);
    const timestamp = now();
    // El cierre se escribe con la precondición `closedAt == null` leída en la misma
    // transacción: dos cierres simultáneos (doble toque) ya no se pisan ni borran la
    // revisión de ajuste que dejó el primero.
    await db().runTransaction(async (transaction) => {
        const [current, salesSnapshot] = await Promise.all([
            transaction.get(ref),
            typeof data === 'function'
                ? transaction.get(sessionSalesQuery(id))
                : Promise.resolve(null),
        ]);
        if (!current.exists) {
            throw badRequest('El turno de caja no existe');
        }
        if (current.data()?.closedAt) {
            throw badRequest('El turno de caja ya está cerrado');
        }
        const closeData = typeof data === 'function'
            ? data(salesSnapshot!.docs.map((doc) => toSessionSaleRow(doc.data())))
            : data;
        transaction.update(ref, {
            closedAt: timestamp,
            closedBy: closeData.closedBy,
            countedCashAmount: closeData.countedCashAmount,
            expectedCashAmount: closeData.expectedCashAmount,
            expectedServicesCashAmount: closeData.expectedServicesCashAmount ?? 0,
            cashDifference: closeData.cashDifference,
            summary: closeData.summary,
            hasPendingAdjustment: closeData.hasPendingAdjustment ?? false,
            adjustmentStatus: closeData.adjustmentStatus ?? null,
            autoClosedByExpiry: closeData.autoClosedByExpiry ?? false,
            // Autocierre sin arqueo (SPEC 63): queda para que un admin lo revise.
            ...(closeData.autoClosedByExpiry ? { autoClosed: true, needsReview: true } : {}),
        });
    });
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as CashSession;
};

interface ListCashSessionsFilters {
    from?: string;
    to?: string;
    openedBy?: string;
    adjustmentStatus?: 'pending' | 'approved' | 'rejected';
    /** Autocerrados por revisar (SPEC 63), incluidos los autocierres anteriores a la marca. */
    needsReview?: boolean;
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
    if (filters.needsReview !== undefined) {
        // Un autocierre de antes de SPEC 63 no tiene `needsReview`, pero nadie lo
        // arqueó: cuenta como por revisar.
        const pending = (session: CashSession): boolean =>
            session.needsReview === true || session.autoClosedByExpiry === true;
        sessions = sessions.filter((session) => pending(session) === filters.needsReview);
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
    /** Fecha de negocio (SPEC 51); `createdAt` en ventas anteriores. */
    businessAt: FirebaseFirestore.Timestamp;
    /** Llegó con el turno ya cerrado (SPEC 52). */
    lateSync: boolean;
}

const sessionSalesQuery = (cashSessionId: string): FirebaseFirestore.Query =>
    db().collection('sales').where('cashSessionId', '==', cashSessionId);

const toSessionSaleRow = (data: FirebaseFirestore.DocumentData): SessionSaleRow => {
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
        businessAt: (data.businessAt ?? data.createdAt) as FirebaseFirestore.Timestamp,
        lateSync: data.lateSync === true,
    };
};

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
    const snapshot = await sessionSalesQuery(cashSessionId).get();
    return snapshot.docs.map((doc) => toSessionSaleRow(doc.data()));
};
