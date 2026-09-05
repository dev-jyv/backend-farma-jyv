import { DirectCharge, DirectChargeStatus } from '../types';
import { paginate } from '../utils/pagination';
import { db, now, toTimestamp } from '../utils/firestore';

/** Ventana por defecto de la lista cuando no se pide rango explícito. */
const DEFAULT_LIST_DAYS = 30;

const collection = () => db().collection('directCharges');

const mapCharge = (id: string, data: FirebaseFirestore.DocumentData): DirectCharge => ({
    id,
    folio: data.folio as string,
    amount: data.amount as number,
    concept: data.concept as string,
    // `channel` es posterior al primer cobro por terminal: los documentos sin él
    // son de la Point.
    channel: (data.channel as DirectCharge['channel'] | undefined) ?? 'point',
    status: data.status as DirectChargeStatus,
    statusDetail: (data.statusDetail as string | null) ?? null,
    point: (data.point as DirectCharge['point']) ?? null,
    online: (data.online as DirectCharge['online']) ?? null,
    cashierId: data.cashierId as string,
    roleSlug: (data.roleSlug as string | null) ?? null,
    canceledBy: (data.canceledBy as string | null) ?? null,
    canceledAt: (data.canceledAt as DirectCharge['canceledAt']) ?? null,
    approvedAt: (data.approvedAt as DirectCharge['approvedAt']) ?? null,
    createdAt: data.createdAt as DirectCharge['createdAt'],
    updatedAt: (data.updatedAt as DirectCharge['updatedAt']) ??
        (data.createdAt as DirectCharge['createdAt']),
});

export const getDirectChargeById = async (id: string): Promise<DirectCharge | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapCharge(doc.id, doc.data()!);
};

export const listDirectCharges = async (filters: {
    from?: string;
    to?: string;
    channel?: DirectCharge['channel'];
    status?: DirectChargeStatus;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: DirectCharge[]; total: number }> => {
    const from = filters.from ??
        new Date(Date.now() - DEFAULT_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let query: FirebaseFirestore.Query = collection().where('createdAt', '>=', toTimestamp(from));
    if (filters.to) {
        query = query.where('createdAt', '<=', toTimestamp(filters.to));
    }
    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    let charges = snapshot.docs.map((doc) => mapCharge(doc.id, doc.data()));

    if (filters.channel) {
        charges = charges.filter((charge) => charge.channel === filters.channel);
    }

    if (filters.status) {
        charges = charges.filter((charge) => charge.status === filters.status);
    }

    // El filtro de texto se aplica en memoria (igual que en ventas): Firestore no
    // hace `contains` y el rango de fechas ya acota el conjunto.
    if (filters.search) {
        const term = filters.search.toLowerCase();
        charges = charges.filter(
            (charge) =>
                charge.folio.toLowerCase().includes(term) ||
                charge.concept.toLowerCase().includes(term) ||
                (charge.point?.orderId.toLowerCase().includes(term) ?? false) ||
                (charge.online?.preferenceId.toLowerCase().includes(term) ?? false),
        );
    }

    return paginate(charges, filters.page ?? 1, filters.limit ?? 50);
};

/**
 * Crea el cobro con el folio consecutivo en una transacción, para que dos cajas
 * cobrando al mismo tiempo no se peleen el mismo folio.
 */
export const createDirectCharge = async (
    input: Omit<DirectCharge, 'id' | 'folio' | 'createdAt' | 'updatedAt'>,
): Promise<DirectCharge> => {
    const firestore = db();
    const chargeRef = collection().doc();
    const counterRef = firestore.collection('counters').doc('directCharges');
    const timestamp = now();

    const folio = await firestore.runTransaction(async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        const nextSequence = ((counterDoc.data()?.value as number | undefined) ?? 0) + 1;
        const nextFolio = `CD-${String(nextSequence).padStart(6, '0')}`;

        transaction.set(counterRef, { value: nextSequence }, { merge: true });
        transaction.create(chargeRef, {
            ...input,
            folio: nextFolio,
            createdAt: timestamp,
            updatedAt: timestamp,
        });

        return nextFolio;
    });

    return { id: chargeRef.id, folio, createdAt: timestamp, updatedAt: timestamp, ...input };
};

export const findDirectChargeByOrderId = async (
    orderId: string,
): Promise<DirectCharge | null> => {
    const snapshot = await collection().where('point.orderId', '==', orderId).limit(1).get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return mapCharge(doc.id, doc.data());
};

export const findDirectChargeByExternalReference = async (
    externalReference: string,
): Promise<DirectCharge | null> => {
    const snapshot = await collection()
        .where('online.externalReference', '==', externalReference)
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    return mapCharge(doc.id, doc.data());
};

export const updateDirectCharge = async (
    id: string,
    data: Partial<
        Pick<
            DirectCharge,
            'status' | 'statusDetail' | 'point' | 'online' |
            'approvedAt' | 'canceledAt' | 'canceledBy'
        >
    >,
): Promise<DirectCharge> => {
    await collection().doc(id).update({ ...data, updatedAt: now() });
    const updated = await getDirectChargeById(id);
    return updated!;
};
