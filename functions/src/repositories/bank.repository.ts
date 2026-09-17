import {
    BankAccount,
    BankMovement,
    BankMovementDirection,
    CashMovement,
} from '../types';
import { db, fromDate, now } from '../utils/firestore';
import { badRequest, notFound } from '../utils/errors';

const accountsCollection = () => db().collection('bankAccounts');
const movementsCollection = () => db().collection('bankMovements');
const cashMovementsCollection = () => db().collection('cashMovements');

const mapAccount = (doc: FirebaseFirestore.DocumentSnapshot): BankAccount =>
    ({ id: doc.id, ...doc.data() }) as BankAccount;

const mapMovement = (doc: FirebaseFirestore.DocumentSnapshot): BankMovement =>
    ({ id: doc.id, ...doc.data() }) as BankMovement;

export const listAccounts = async (options: {
    includeInactive?: boolean;
} = {}): Promise<BankAccount[]> => {
    const snapshot = await accountsCollection().orderBy('name').get();
    const accounts = snapshot.docs.map(mapAccount);
    return options.includeInactive ? accounts : accounts.filter((account) => account.isActive);
};

export const getAccountById = async (id: string): Promise<BankAccount | null> => {
    const doc = await accountsCollection().doc(id).get();
    return doc.exists ? mapAccount(doc) : null;
};

export const createAccount = async (input: {
    name: string;
    bank: string;
    last4?: string;
    openingBalance: number;
    openingDate: Date;
    createdBy: string;
}): Promise<BankAccount> => {
    const payload = {
        name: input.name,
        bank: input.bank,
        last4: input.last4 ?? null,
        openingBalance: input.openingBalance,
        openingDate: fromDate(input.openingDate),
        isActive: true,
        createdBy: input.createdBy,
        createdAt: now(),
        updatedBy: null,
        updatedAt: null,
    };
    const ref = await accountsCollection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateAccount = async (
    id: string,
    patch: {
        name?: string;
        bank?: string;
        last4?: string | null;
        openingBalance?: number;
        openingDate?: Date;
        isActive?: boolean;
    },
    userId: string,
): Promise<BankAccount> => {
    const data: Record<string, unknown> = { updatedAt: now(), updatedBy: userId };
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.bank !== undefined) data.bank = patch.bank;
    if (patch.last4 !== undefined) data.last4 = patch.last4;
    if (patch.openingBalance !== undefined) data.openingBalance = patch.openingBalance;
    if (patch.openingDate !== undefined) data.openingDate = fromDate(patch.openingDate);
    if (patch.isActive !== undefined) data.isActive = patch.isActive;

    const ref = accountsCollection().doc(id);
    await ref.update(data);
    return mapAccount(await ref.get());
};

export const listMovements = async (filters: {
    accountId?: string;
    from?: Date;
    to?: Date;
} = {}): Promise<BankMovement[]> => {
    let query = movementsCollection().orderBy('occurredAt', 'desc') as FirebaseFirestore.Query;
    if (filters.accountId) {
        query = query.where('accountId', '==', filters.accountId);
    }
    if (filters.from) {
        query = query.where('occurredAt', '>=', fromDate(filters.from));
    }
    if (filters.to) {
        query = query.where('occurredAt', '<=', fromDate(filters.to));
    }
    const snapshot = await query.get();
    return snapshot.docs.map(mapMovement);
};

export const createMovement = async (input: {
    accountId: string;
    direction: BankMovementDirection;
    amount: number;
    occurredAt: Date;
    concept: string;
    reference?: string;
    createdBy: string;
    createdByLabel?: string;
}): Promise<BankMovement> => {
    const payload = {
        accountId: input.accountId,
        direction: input.direction,
        amount: input.amount,
        occurredAt: fromDate(input.occurredAt),
        concept: input.concept,
        reference: input.reference ?? null,
        origin: 'manual' as const,
        cashMovementId: null,
        reconciledAt: null,
        reconciledBy: null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        createdAt: now(),
    };
    const ref = await movementsCollection().add(payload);
    return { id: ref.id, ...payload };
};

/**
 * Traspaso entre la caja de la farmacia y una cuenta bancaria.
 *
 * Las dos mitades se escriben en un **lote atómico**: si solo entrara una, el
 * dinero aparecería duplicado (queda en caja y además en el banco) o
 * desaparecido. Es exactamente el descuadre que este módulo vino a cerrar.
 */
export const createTransfer = async (input: {
    accountId: string;
    /** `toBank` saca efectivo de la caja; `toCash` lo trae del banco. */
    direction: 'toBank' | 'toCash';
    amount: number;
    occurredAt: Date;
    concept: string;
    reference?: string;
    createdBy: string;
    createdByLabel?: string;
}): Promise<{ bankMovement: BankMovement; cashMovement: CashMovement }> => {
    const firestore = db();
    const batch = firestore.batch();
    const timestamp = now();
    const occurredAt = fromDate(input.occurredAt);

    const bankRef = movementsCollection().doc();
    const cashRef = cashMovementsCollection().doc();

    const cashPayload = {
        // Sin turno: el traspaso lo hace el admin, no el mostrador, y no debe
        // entrar a ningún corte de caja.
        cashSessionId: null,
        type: input.direction === 'toBank' ? ('withdrawal' as const) : ('deposit' as const),
        amount: input.amount,
        reason: input.concept,
        category: null,
        description: null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        // Es efectivo por definición: lo que sale o entra al cajón.
        paymentMethod: 'cash' as const,
        bankAccountId: input.accountId,
        occurredAt,
        createdAt: timestamp,
    };

    const bankPayload = {
        accountId: input.accountId,
        direction: input.direction === 'toBank' ? ('in' as const) : ('out' as const),
        amount: input.amount,
        occurredAt,
        concept: input.concept,
        reference: input.reference ?? null,
        origin: 'transfer' as const,
        cashMovementId: cashRef.id,
        reconciledAt: null,
        reconciledBy: null,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel ?? null,
        createdAt: timestamp,
    };

    batch.set(cashRef, cashPayload);
    batch.set(bankRef, bankPayload);
    await batch.commit();

    return {
        bankMovement: { id: bankRef.id, ...bankPayload },
        cashMovement: { id: cashRef.id, ...cashPayload } as CashMovement,
    };
};

export const setReconciled = async (
    movementId: string,
    reconciled: boolean,
    userId: string,
): Promise<BankMovement> => {
    const ref = movementsCollection().doc(movementId);
    const doc = await ref.get();
    if (!doc.exists) {
        throw notFound('Movimiento bancario');
    }
    const movement = mapMovement(doc);
    if (reconciled && movement.reconciledAt) {
        throw badRequest('Este movimiento ya está conciliado');
    }

    await ref.update(
        reconciled
            ? { reconciledAt: now(), reconciledBy: userId }
            : { reconciledAt: null, reconciledBy: null },
    );
    return mapMovement(await ref.get());
};
