import {
    AccountingSettings,
    EquityMovement,
    EquityMovementType,
    FixedAsset,
    FixedAssetCategory,
    OpeningBalances,
} from '../types';
import { db, fromDate, now } from '../utils/firestore';

const settingsCollection = () => db().collection('accountingSettings');
const assetsCollection = () => db().collection('fixedAssets');
const equityCollection = () => db().collection('equityMovements');

/**
 * Documento único de configuración. Id fijo y no una consulta "el primero que
 * haya": dos documentos de configuración conviviendo significan dos contabilidades
 * distintas según a cuál le toque salir primero.
 */
const SETTINGS_ID = 'default';

/** Todo en cero: lo que ve una farmacia que aún no capturó su apertura. */
const EMPTY_BALANCES: OpeningBalances = {
    cash: 0,
    bank: 0,
    inventory: 0,
    payables: 0,
    fixedAssets: 0,
    accumulatedDepreciation: 0,
    equityContributions: 0,
    retainedEarnings: 0,
};

export const getSettings = async (): Promise<AccountingSettings> => {
    const doc = await settingsCollection().doc(SETTINGS_ID).get();
    if (!doc.exists) {
        // Nunca `null`: la contabilidad tiene que poder leerse desde el primer
        // día, con la apertura en ceros y sin periodos cerrados.
        return { startDate: null, openingBalances: { ...EMPTY_BALANCES }, closedThrough: null };
    }
    const data = doc.data()!;
    return {
        startDate: data.startDate ?? null,
        openingBalances: { ...EMPTY_BALANCES, ...(data.openingBalances ?? {}) },
        closedThrough: data.closedThrough ?? null,
        updatedBy: data.updatedBy ?? null,
        updatedAt: data.updatedAt ?? null,
    };
};

export const saveSettings = async (
    patch: {
        startDate?: Date | null;
        openingBalances?: Partial<OpeningBalances>;
        closedThrough?: Date | null;
    },
    userId: string,
): Promise<AccountingSettings> => {
    const current = await getSettings();
    const payload: Record<string, unknown> = { updatedAt: now(), updatedBy: userId };

    if (patch.startDate !== undefined) {
        payload.startDate = patch.startDate ? fromDate(patch.startDate) : null;
    }
    if (patch.closedThrough !== undefined) {
        payload.closedThrough = patch.closedThrough ? fromDate(patch.closedThrough) : null;
    }
    if (patch.openingBalances) {
        // Mezcla sobre lo que ya había: un PUT parcial no debe poner en cero los
        // rubros que el formulario no mandó.
        payload.openingBalances = { ...current.openingBalances, ...patch.openingBalances };
    }

    await settingsCollection().doc(SETTINGS_ID).set(payload, { merge: true });
    return getSettings();
};

/* -------------------------------------------------------------------------- */
/*  Activo fijo                                                               */
/* -------------------------------------------------------------------------- */

const mapAsset = (doc: FirebaseFirestore.DocumentSnapshot): FixedAsset =>
    ({ id: doc.id, ...doc.data() }) as FixedAsset;

export const listFixedAssets = async (options: {
    includeDisposed?: boolean;
} = {}): Promise<FixedAsset[]> => {
    const snapshot = await assetsCollection().orderBy('acquiredAt', 'desc').get();
    const assets = snapshot.docs.map(mapAsset);
    return options.includeDisposed
        ? assets
        : assets.filter((asset) => !asset.disposedAt);
};

export const getFixedAssetById = async (id: string): Promise<FixedAsset | null> => {
    const doc = await assetsCollection().doc(id).get();
    return doc.exists ? mapAsset(doc) : null;
};

export const createFixedAsset = async (input: {
    name: string;
    category: FixedAssetCategory;
    acquiredAt: Date;
    cost: number;
    usefulLifeMonths: number;
    salvageValue: number;
    notes?: string;
    createdBy: string;
}): Promise<FixedAsset> => {
    const timestamp = now();
    const payload = {
        name: input.name,
        category: input.category,
        acquiredAt: fromDate(input.acquiredAt),
        cost: input.cost,
        usefulLifeMonths: input.usefulLifeMonths,
        salvageValue: input.salvageValue,
        notes: input.notes ?? null,
        disposedAt: null,
        disposalAmount: null,
        disposalReason: null,
        createdBy: input.createdBy,
        createdAt: timestamp,
        updatedBy: null,
        updatedAt: null,
    };
    const ref = await assetsCollection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateFixedAsset = async (
    id: string,
    patch: {
        name?: string;
        category?: FixedAssetCategory;
        acquiredAt?: Date;
        cost?: number;
        usefulLifeMonths?: number;
        salvageValue?: number;
        notes?: string | null;
        disposedAt?: Date | null;
        disposalAmount?: number | null;
        disposalReason?: string | null;
    },
    userId: string,
): Promise<FixedAsset> => {
    const data: Record<string, unknown> = { updatedAt: now(), updatedBy: userId };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.acquiredAt !== undefined) data.acquiredAt = fromDate(patch.acquiredAt);
    if (patch.cost !== undefined) data.cost = patch.cost;
    if (patch.usefulLifeMonths !== undefined) data.usefulLifeMonths = patch.usefulLifeMonths;
    if (patch.salvageValue !== undefined) data.salvageValue = patch.salvageValue;
    if (patch.notes !== undefined) data.notes = patch.notes;
    if (patch.disposedAt !== undefined) {
        data.disposedAt = patch.disposedAt ? fromDate(patch.disposedAt) : null;
    }
    if (patch.disposalAmount !== undefined) data.disposalAmount = patch.disposalAmount;
    if (patch.disposalReason !== undefined) data.disposalReason = patch.disposalReason;

    const ref = assetsCollection().doc(id);
    await ref.update(data);
    return mapAsset(await ref.get());
};

/* -------------------------------------------------------------------------- */
/*  Capital                                                                   */
/* -------------------------------------------------------------------------- */

export const listEquityMovements = async (filters: {
    from?: Date;
    to?: Date;
} = {}): Promise<EquityMovement[]> => {
    let query = equityCollection().orderBy('occurredAt', 'desc') as FirebaseFirestore.Query;
    if (filters.from) {
        query = query.where('occurredAt', '>=', fromDate(filters.from));
    }
    if (filters.to) {
        query = query.where('occurredAt', '<=', fromDate(filters.to));
    }
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as EquityMovement);
};

export const createEquityMovement = async (input: {
    type: EquityMovementType;
    amount: number;
    occurredAt: Date;
    partner: string;
    note?: string;
    createdBy: string;
    createdByLabel?: string;
}): Promise<EquityMovement> => {
    const payload = {
        type: input.type,
        amount: input.amount,
        occurredAt: fromDate(input.occurredAt),
        partner: input.partner,
        note: input.note ?? null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        createdAt: now(),
    };
    const ref = await equityCollection().add(payload);
    return { id: ref.id, ...payload };
};
