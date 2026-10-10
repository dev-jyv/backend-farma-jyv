import * as bankRepo from '../repositories/bank.repository';
import * as cashMovementsRepo from '../repositories/cash-movements.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as salesRepo from '../repositories/sales.repository';
import { BankAccount, BankMovement, Sale } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { fromCents, toCents } from '../utils/taxes';
import { assertPeriodOpen } from './accounting-core.service';
import { recordAudit } from './audit.service';

/**
 * Bancos y conciliación.
 *
 * El saldo de una cuenta **se calcula**, no se guarda: parte del saldo inicial y
 * suma lo que ya vive en otras colecciones —gastos y abonos a proveedor con
 * `bankAccountId`— más los movimientos bancarios propios (capturas sueltas y
 * traspasos). Guardar un saldo obligaría a actualizarlo en cada escritura desde
 * cuatro sitios distintos, y el día que una fallara nadie volvería a saber cuál
 * de los dos números es el bueno.
 */

export interface BankAccountBalance extends BankAccount {
    balance: number;
    /** Desglose de cómo se llegó al saldo; es lo que se revisa cuando no cuadra. */
    movements: {
        transfersIn: number;
        transfersOut: number;
        manualIn: number;
        manualOut: number;
        expenses: number;
        supplierPayments: number;
    };
}

/** Suma en centavos lo que salió de una cuenta por gastos y abonos. */
const outflowsFromOtherCollections = async (
    accountId: string,
    from: Date,
    to: Date,
): Promise<{ expensesCents: number; paymentsCents: number }> => {
    const [movements, payments] = await Promise.all([
        cashMovementsRepo.listForPeriod({ from: from.toISOString(), to: to.toISOString() }),
        invoicesRepo.listPaymentsForPeriod({ from, to }),
    ]);

    // `expense` y `withdrawal`: el pago de un gasto devengado sale como retiro
    // —el gasto ya pegó en resultados al devengarse— y aun así saca dinero de la
    // cuenta. Dejarlo fuera inflaría el saldo bancario.
    const expensesCents = movements
        .filter(
            (movement) =>
                (movement.type === 'expense' || movement.type === 'withdrawal') &&
                movement.bankAccountId === accountId &&
                (movement.paymentMethod ?? 'cash') !== 'cash',
        )
        .reduce((total, movement) => total + toCents(movement.amount), 0);

    // Las contrapartidas de un abono cancelado vienen en negativo y devuelven el
    // dinero a la cuenta por sí solas.
    const paymentsCents = payments
        .filter((payment) => payment.bankAccountId === accountId)
        .reduce((total, payment) => total + toCents(payment.amount), 0);

    return { expensesCents, paymentsCents };
};

export const getAccountsWithBalance = async (options: {
    includeInactive?: boolean;
    asOf?: Date;
} = {}): Promise<BankAccountBalance[]> => {
    const asOf = options.asOf ?? new Date();
    const accounts = await bankRepo.listAccounts({
        ...(options.includeInactive ? { includeInactive: true } : {}),
    });

    return Promise.all(
        accounts.map(async (account) => {
            const openingDate = account.openingDate.toDate();
            const [movements, outflows] = await Promise.all([
                bankRepo.listMovements({ accountId: account.id, from: openingDate, to: asOf }),
                outflowsFromOtherCollections(account.id, openingDate, asOf),
            ]);

            const sum = (
                predicate: (movement: BankMovement) => boolean,
            ): number =>
                movements
                    .filter(predicate)
                    .reduce((total, movement) => total + toCents(movement.amount), 0);

            const transfersIn = sum((m) => m.origin === 'transfer' && m.direction === 'in');
            const transfersOut = sum((m) => m.origin === 'transfer' && m.direction === 'out');
            const manualIn = sum((m) => m.origin === 'manual' && m.direction === 'in');
            const manualOut = sum((m) => m.origin === 'manual' && m.direction === 'out');

            const balanceCents =
                toCents(account.openingBalance) +
                transfersIn + manualIn -
                transfersOut - manualOut -
                outflows.expensesCents - outflows.paymentsCents;

            return {
                ...account,
                balance: fromCents(balanceCents),
                movements: {
                    transfersIn: fromCents(transfersIn),
                    transfersOut: fromCents(transfersOut),
                    manualIn: fromCents(manualIn),
                    manualOut: fromCents(manualOut),
                    expenses: fromCents(outflows.expensesCents),
                    supplierPayments: fromCents(outflows.paymentsCents),
                },
            };
        }),
    );
};

/** Saldo total de las cuentas activas; es el renglón "Bancos" del balance. */
export const getBankTotal = async (asOf?: Date): Promise<{
    total: number;
    accountCount: number;
}> => {
    const accounts = await getAccountsWithBalance({ ...(asOf ? { asOf } : {}) });
    return {
        total: fromCents(
            accounts.reduce((sum, account) => sum + toCents(account.balance), 0),
        ),
        accountCount: accounts.length,
    };
};

export const createAccount = async (
    input: {
        name: string;
        bank: string;
        last4?: string;
        openingBalance: number;
        openingDate: string;
    },
    userId: string,
    roleSlug: string,
): Promise<BankAccount> => {
    const account = await bankRepo.createAccount({
        ...input,
        openingDate: new Date(input.openingDate),
        createdBy: userId,
    });

    await recordAudit({
        action: 'bankAccount.created',
        entity: 'bankAccount',
        entityId: account.id,
        summary: `Cuenta bancaria "${input.name}" (${input.bank}) con saldo inicial ` +
            `${input.openingBalance.toFixed(2)} al ${input.openingDate}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return account;
};

export const updateAccount = async (
    id: string,
    patch: {
        name?: string;
        bank?: string;
        last4?: string | null;
        openingBalance?: number;
        openingDate?: string;
        isActive?: boolean;
    },
    userId: string,
    roleSlug: string,
): Promise<BankAccount> => {
    const current = await bankRepo.getAccountById(id);
    if (!current) {
        throw notFound('Cuenta bancaria');
    }

    const { openingDate, ...rest } = patch;
    const account = await bankRepo.updateAccount(
        id,
        {
            ...rest,
            ...(openingDate ? { openingDate: new Date(openingDate) } : {}),
        },
        userId,
    );

    await recordAudit({
        action: 'bankAccount.updated',
        entity: 'bankAccount',
        entityId: id,
        summary: `Cuenta bancaria "${account.name}" actualizada`,
        userId,
        roleSlug,
        metadata: { ...patch },
    });

    return account;
};

export const listMovements = (filters: {
    accountId?: string;
    from?: string;
    to?: string;
}): Promise<BankMovement[]> =>
    bankRepo.listMovements({
        ...(filters.accountId ? { accountId: filters.accountId } : {}),
        ...(filters.from ? { from: new Date(filters.from) } : {}),
        ...(filters.to ? { to: new Date(filters.to) } : {}),
    });

const assertAccountUsable = async (accountId: string): Promise<BankAccount> => {
    const account = await bankRepo.getAccountById(accountId);
    if (!account) {
        throw notFound('Cuenta bancaria');
    }
    if (!account.isActive) {
        throw badRequest('La cuenta bancaria está desactivada');
    }
    return account;
};

export const createMovement = async (
    input: {
        accountId: string;
        direction: 'in' | 'out';
        amount: number;
        occurredAt: string;
        concept: string;
        reference?: string;
    },
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<BankMovement> => {
    const account = await assertAccountUsable(input.accountId);
    const occurredAt = new Date(input.occurredAt);
    await assertPeriodOpen(occurredAt, 'Movimiento bancario');

    const movement = await bankRepo.createMovement({
        ...input,
        occurredAt,
        createdBy: userId,
        ...(userLabel ? { createdByLabel: userLabel } : {}),
    });

    await recordAudit({
        action: 'bankMovement.created',
        entity: 'bankMovement',
        entityId: movement.id,
        summary: `${input.direction === 'in' ? 'Entrada' : 'Salida'} de ` +
            `${input.amount.toFixed(2)} en ${account.name}: ${input.concept}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return movement;
};

/**
 * Traspaso caja ↔ banco. Es la operación que vuelve innecesaria la estimación:
 * antes movía el efectivo sin que nada lo recibiera del otro lado.
 */
export const createTransfer = async (
    input: {
        accountId: string;
        direction: 'toBank' | 'toCash';
        amount: number;
        occurredAt: string;
        concept: string;
        reference?: string;
    },
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<BankMovement> => {
    const account = await assertAccountUsable(input.accountId);
    const occurredAt = new Date(input.occurredAt);
    await assertPeriodOpen(occurredAt, 'Traspaso');

    const { bankMovement } = await bankRepo.createTransfer({
        ...input,
        occurredAt,
        createdBy: userId,
        ...(userLabel ? { createdByLabel: userLabel } : {}),
    });

    await recordAudit({
        action: 'bankMovement.created',
        entity: 'bankMovement',
        entityId: bankMovement.id,
        summary: `Traspaso de ${input.amount.toFixed(2)} ` +
            `${input.direction === 'toBank' ? 'de caja a' : 'de'} ${account.name}` +
            `${input.direction === 'toCash' ? ' a caja' : ''}: ${input.concept}`,
        userId,
        roleSlug,
        metadata: { ...input, cashMovementId: bankMovement.cashMovementId },
    });

    return bankMovement;
};

export const setReconciled = async (
    movementId: string,
    reconciled: boolean,
    userId: string,
    roleSlug: string,
): Promise<BankMovement> => {
    const movement = await bankRepo.setReconciled(movementId, reconciled, userId);

    await recordAudit({
        action: 'bankMovement.reconciled',
        entity: 'bankMovement',
        entityId: movementId,
        summary: reconciled
            ? `Movimiento bancario conciliado: ${movement.concept}`
            : `Conciliación deshecha: ${movement.concept}`,
        userId,
        roleSlug,
        metadata: { reconciled },
    });

    return movement;
};

/* -------------------------------------------------------------------------- */
/*  Conciliación                                                              */
/* -------------------------------------------------------------------------- */

export interface ReconciliationReport {
    period: { from: string; to: string };
    /** Cobros que **debieron** llegar al banco: tarjeta y transferencia de las ventas. */
    expectedInflow: number;
    /** Entradas efectivamente capturadas en las cuentas (manuales y traspasos). */
    registeredInflow: number;
    /** `expectedInflow - registeredInflow`: lo que falta por capturar o conciliar. */
    inflowGap: number;
    registeredOutflow: number;
    /** Movimientos sin marcar contra el estado de cuenta. */
    unreconciled: { count: number; total: number };
    accounts: Array<{ id: string; name: string; balance: number }>;
    notes: string[];
}

/** Lo que una venta no cobró en efectivo tuvo que llegar al banco. */
const nonCashCents = (sale: Sale): number => {
    const cash = sale.cashAmount ?? (sale.paymentMethod === 'cash' ? sale.total : 0);
    return Math.max(toCents(sale.total) - toCents(cash), 0);
};

/**
 * Conciliación del periodo: lo que el sistema esperaba que entrara al banco
 * contra lo que de verdad se capturó.
 *
 * La diferencia **no se corrige sola**. Se publica: casi siempre es un depósito
 * de la terminal que aún no se registra, y esconderlo detrás de un saldo
 * "ajustado" haría imposible descubrir el día que falte dinero de verdad.
 */
export const getReconciliation = async (filters: {
    from: string;
    to: string;
    accountId?: string;
}): Promise<ReconciliationReport> => {
    const from = new Date(filters.from);
    const to = new Date(filters.to);

    const [sales, movements, accounts] = await Promise.all([
        salesRepo.listSales({ from: filters.from, to: filters.to }),
        bankRepo.listMovements({
            ...(filters.accountId ? { accountId: filters.accountId } : {}),
            from,
            to,
        }),
        getAccountsWithBalance({ asOf: to }),
    ]);

    const expectedCents = sales.items.reduce((total, sale) => total + nonCashCents(sale), 0);
    const registeredInCents = movements
        .filter((movement) => movement.direction === 'in')
        .reduce((total, movement) => total + toCents(movement.amount), 0);
    const registeredOutCents = movements
        .filter((movement) => movement.direction === 'out')
        .reduce((total, movement) => total + toCents(movement.amount), 0);

    const pending = movements.filter((movement) => !movement.reconciledAt);
    const notes: string[] = [];

    if (accounts.length === 0) {
        notes.push(
            'No hay cuentas bancarias dadas de alta: mientras no existan, el balance ' +
            'sigue estimando el saldo de bancos a partir del flujo conocido.',
        );
    }
    const gapCents = expectedCents - registeredInCents;
    if (Math.abs(gapCents) > 100) {
        notes.push(
            'Hay diferencia entre lo cobrado con tarjeta o transferencia y lo capturado en ' +
            'el banco. Suele ser un depósito de la terminal todavía sin registrar.',
        );
    }
    if (pending.length > 0) {
        notes.push(
            `${pending.length} movimiento(s) sin marcar contra el estado de cuenta.`,
        );
    }

    return {
        period: { from: filters.from, to: filters.to },
        expectedInflow: fromCents(expectedCents),
        registeredInflow: fromCents(registeredInCents),
        inflowGap: fromCents(gapCents),
        registeredOutflow: fromCents(registeredOutCents),
        unreconciled: {
            count: pending.length,
            total: fromCents(
                pending.reduce((total, movement) => total + toCents(movement.amount), 0),
            ),
        },
        accounts: accounts.map((account) => ({
            id: account.id,
            name: account.name,
            balance: account.balance,
        })),
        notes,
    };
};
