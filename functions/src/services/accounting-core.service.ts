import {
    EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION,
    EXPENSE_CATEGORY_LABELS,
} from '../constants/expenses';
import * as accountingRepo from '../repositories/accounting.repository';
import * as accruedRepo from '../repositories/accrued-expenses.repository';
import {
    AccountingSettings,
    AccruedExpense,
    EquityMovement,
    ExpenseCategory,
    ExpensePaymentMethod,
    FixedAsset,
    FixedAssetCategory,
    OpeningBalances,
} from '../types';
import { badRequest, notFound } from '../utils/errors';
import { fromCents, toCents } from '../utils/taxes';
import { recordAudit } from './audit.service';

/**
 * Configuración contable, activo fijo y capital.
 *
 * Vive aparte de `accounting.service` para no hacer de ese archivo un cajón de
 * sastre: aquí están los **catálogos y las reglas de fecha**; allá, los informes
 * que los consumen.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  Configuración y cierre de periodo                                         */
/* -------------------------------------------------------------------------- */

export const getSettings = (): Promise<AccountingSettings> => accountingRepo.getSettings();

export const updateSettings = async (
    input: {
        startDate?: string | null;
        openingBalances?: Partial<OpeningBalances>;
    },
    userId: string,
    roleSlug: string,
): Promise<AccountingSettings> => {
    const current = await accountingRepo.getSettings();

    // La fecha de arranque no puede meterse dentro de lo ya cerrado: movería el
    // punto de partida de periodos que alguien ya reportó.
    if (input.startDate && current.closedThrough) {
        const startDate = new Date(input.startDate);
        if (startDate > current.closedThrough.toDate()) {
            throw badRequest(
                'La fecha de arranque no puede ser posterior al último periodo cerrado',
            );
        }
    }

    const settings = await accountingRepo.saveSettings(
        {
            ...(input.startDate !== undefined
                ? { startDate: input.startDate ? new Date(input.startDate) : null }
                : {}),
            ...(input.openingBalances ? { openingBalances: input.openingBalances } : {}),
        },
        userId,
    );

    await recordAudit({
        action: 'accountingSettings.updated',
        entity: 'accountingSettings',
        entityId: 'default',
        summary: 'Configuración contable actualizada' +
            (input.startDate !== undefined ? ` (arranque: ${input.startDate ?? 'sin fecha'})` : ''),
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return settings;
};

/**
 * Cierra —o reabre, con `through: null`— los periodos contables.
 *
 * Reabrir es tan auditable como cerrar y a propósito: es la única salida cuando
 * se cerró un mes por error, y esconderla llevaría a corregir las cifras por
 * abajo, fechando movimientos donde no van.
 */
export const closePeriod = async (
    through: string | null,
    userId: string,
    roleSlug: string,
): Promise<AccountingSettings> => {
    if (through && new Date(through) > new Date()) {
        throw badRequest('No se puede cerrar un periodo que todavía no termina');
    }

    const settings = await accountingRepo.saveSettings(
        { closedThrough: through ? new Date(through) : null },
        userId,
    );

    await recordAudit({
        action: 'accountingPeriod.closed',
        entity: 'accountingSettings',
        entityId: 'default',
        summary: through
            ? `Periodos contables cerrados hasta el ${through}`
            : 'Periodos contables reabiertos',
        userId,
        roleSlug,
        metadata: { through },
    });

    return settings;
};

/**
 * Rechaza un movimiento fechado dentro de un periodo ya cerrado.
 *
 * Se llama desde el alta de gastos, abonos y movimientos de capital: son las
 * tres puertas por las que entra dinero con fecha elegida por el usuario. Sin
 * esto, un estado de resultados firmado cambia de cifra cuando alguien captura
 * un gasto "del mes pasado".
 */
export const assertPeriodOpen = async (occurredAt: Date, concept: string): Promise<void> => {
    const { closedThrough } = await accountingRepo.getSettings();
    if (closedThrough && occurredAt <= closedThrough.toDate()) {
        const fecha = closedThrough.toDate().toISOString().slice(0, 10);
        throw badRequest(
            `${concept}: el periodo está cerrado hasta el ${fecha}. ` +
            'Reabre el periodo o usa una fecha posterior.',
        );
    }
};

/* -------------------------------------------------------------------------- */
/*  Activo fijo y depreciación                                                */
/* -------------------------------------------------------------------------- */

/** Base depreciable: lo que se va a repartir a lo largo de la vida útil. */
const depreciableBaseCents = (asset: FixedAsset): number =>
    Math.max(toCents(asset.cost) - toCents(asset.salvageValue), 0);

/** Fin de la vida útil: es lo que fija el **ritmo** de la depreciación. */
const lifeEndOf = (asset: FixedAsset): Date => {
    const lifeEnd = new Date(asset.acquiredAt.toDate());
    lifeEnd.setMonth(lifeEnd.getMonth() + asset.usefulLifeMonths);
    return lifeEnd;
};

/**
 * Último día en que el bien deprecia: su baja, o el fin de su vida útil.
 *
 * Solo acorta la **ventana**, nunca el ritmo: repartir la base entre los días
 * que el bien alcanzó a vivir dejaría un refrigerador dado de baja a los seis
 * meses depreciado al 100 %, como si se hubiera consumido el doble de rápido.
 */
const depreciationEnd = (asset: FixedAsset): Date => {
    const lifeEnd = lifeEndOf(asset);
    const disposed = asset.disposedAt?.toDate();
    return disposed && disposed < lifeEnd ? disposed : lifeEnd;
};

/**
 * Depreciación en línea recta del bien **dentro de un rango**, en centavos.
 *
 * Se prorratea por días y no por meses completos: un periodo contable no tiene
 * por qué empezar el día 1, y con la convención de mes completo un bien comprado
 * el 28 cargaría el mes entero al periodo equivocado. El total nunca pasa de la
 * base depreciable, ni sigue corriendo después de la baja.
 */
export const depreciationInRangeCents = (asset: FixedAsset, from: Date, to: Date): number => {
    const base = depreciableBaseCents(asset);
    if (base <= 0 || asset.usefulLifeMonths <= 0) {
        return 0;
    }

    const start = asset.acquiredAt.toDate();
    const end = depreciationEnd(asset);
    // El divisor es la **vida útil completa**, no la ventana: ver `depreciationEnd`.
    const totalDays = Math.max(
        Math.round((lifeEndOf(asset).getTime() - start.getTime()) / MS_PER_DAY),
        1,
    );

    // Intersección del rango pedido con la vida del bien.
    const windowStart = from > start ? from : start;
    const windowEnd = to < end ? to : end;
    if (windowEnd <= windowStart) {
        return 0;
    }

    const days = (windowEnd.getTime() - windowStart.getTime()) / MS_PER_DAY;
    return Math.min(Math.round((base * days) / totalDays), base);
};

/** Depreciación acumulada desde la compra hasta la fecha dada. */
export const accumulatedDepreciationCents = (asset: FixedAsset, asOf: Date): number =>
    depreciationInRangeCents(asset, asset.acquiredAt.toDate(), asOf);

export interface FixedAssetView extends FixedAsset {
    /** Depreciación acumulada a la fecha de consulta. */
    accumulatedDepreciation: number;
    /** Costo menos depreciación acumulada; nunca por debajo del valor de rescate. */
    netValue: number;
    /** Depreciación mensual en línea recta, para leer el renglón de un vistazo. */
    monthlyDepreciation: number;
    /** `true` si ya se depreció por completo o si el bien está dado de baja. */
    fullyDepreciated: boolean;
}

const toView = (asset: FixedAsset, asOf: Date): FixedAssetView => {
    const accumulatedCents = accumulatedDepreciationCents(asset, asOf);
    const monthlyCents = asset.usefulLifeMonths > 0
        ? Math.round(depreciableBaseCents(asset) / asset.usefulLifeMonths)
        : 0;

    return {
        ...asset,
        accumulatedDepreciation: fromCents(accumulatedCents),
        netValue: fromCents(toCents(asset.cost) - accumulatedCents),
        monthlyDepreciation: fromCents(monthlyCents),
        fullyDepreciated: Boolean(asset.disposedAt) ||
            accumulatedCents >= depreciableBaseCents(asset),
    };
};

export const listFixedAssets = async (options: {
    includeDisposed?: boolean;
    asOf?: string;
} = {}): Promise<{
    items: FixedAssetView[];
    totals: { cost: number; accumulatedDepreciation: number; netValue: number };
}> => {
    const asOf = options.asOf ? new Date(options.asOf) : new Date();
    const assets = await accountingRepo.listFixedAssets({
        includeDisposed: options.includeDisposed,
    });
    const items = assets.map((asset) => toView(asset, asOf));

    return {
        items,
        totals: {
            cost: fromCents(items.reduce((sum, item) => sum + toCents(item.cost), 0)),
            accumulatedDepreciation: fromCents(
                items.reduce((sum, item) => sum + toCents(item.accumulatedDepreciation), 0),
            ),
            netValue: fromCents(items.reduce((sum, item) => sum + toCents(item.netValue), 0)),
        },
    };
};

export const createFixedAsset = async (
    input: {
        name: string;
        category: FixedAssetCategory;
        acquiredAt: string;
        cost: number;
        usefulLifeMonths: number;
        salvageValue: number;
        notes?: string;
    },
    userId: string,
    roleSlug: string,
): Promise<FixedAssetView> => {
    const asset = await accountingRepo.createFixedAsset({
        ...input,
        acquiredAt: new Date(input.acquiredAt),
        createdBy: userId,
    });

    await recordAudit({
        action: 'fixedAsset.created',
        entity: 'fixedAsset',
        entityId: asset.id,
        summary: `Activo fijo "${input.name}" por ${input.cost.toFixed(2)}, ` +
            `${input.usefulLifeMonths} meses de vida útil`,
        userId,
        roleSlug,
        metadata: { cost: input.cost, usefulLifeMonths: input.usefulLifeMonths },
    });

    return toView(asset, new Date());
};

export const updateFixedAsset = async (
    id: string,
    patch: {
        name?: string;
        category?: FixedAssetCategory;
        cost?: number;
        usefulLifeMonths?: number;
        salvageValue?: number;
        notes?: string | null;
    },
    userId: string,
    roleSlug: string,
): Promise<FixedAssetView> => {
    const current = await accountingRepo.getFixedAssetById(id);
    if (!current) {
        throw notFound('Activo fijo');
    }
    if (current.disposedAt) {
        throw badRequest('Un bien dado de baja ya no se corrige');
    }

    // El rescate se valida contra el costo **resultante**, no contra el que
    // traía: bajar el costo por debajo del rescate dejaría una base negativa.
    const cost = patch.cost ?? current.cost;
    const salvageValue = patch.salvageValue ?? current.salvageValue;
    if (salvageValue >= cost) {
        throw badRequest('El valor de rescate debe ser menor al costo');
    }

    const asset = await accountingRepo.updateFixedAsset(id, patch, userId);

    await recordAudit({
        action: 'fixedAsset.updated',
        entity: 'fixedAsset',
        entityId: id,
        summary: `Activo fijo "${asset.name}" corregido`,
        userId,
        roleSlug,
        metadata: { ...patch },
    });

    return toView(asset, new Date());
};

export const disposeFixedAsset = async (
    id: string,
    input: { disposedAt: string; disposalAmount: number; reason: string },
    userId: string,
    roleSlug: string,
): Promise<FixedAssetView> => {
    const current = await accountingRepo.getFixedAssetById(id);
    if (!current) {
        throw notFound('Activo fijo');
    }
    if (current.disposedAt) {
        throw badRequest('Este bien ya está dado de baja');
    }

    const disposedAt = new Date(input.disposedAt);
    if (disposedAt < current.acquiredAt.toDate()) {
        throw badRequest('La baja no puede ser anterior a la compra del bien');
    }
    await assertPeriodOpen(disposedAt, 'Baja de activo fijo');

    const asset = await accountingRepo.updateFixedAsset(
        id,
        {
            disposedAt,
            disposalAmount: input.disposalAmount,
            disposalReason: input.reason.trim(),
        },
        userId,
    );

    await recordAudit({
        action: 'fixedAsset.disposed',
        entity: 'fixedAsset',
        entityId: id,
        summary: `Activo fijo "${asset.name}" dado de baja el ${input.disposedAt} ` +
            `(recuperado ${input.disposalAmount.toFixed(2)}): ${input.reason.trim()}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return toView(asset, new Date());
};

/* -------------------------------------------------------------------------- */
/*  Capital                                                                   */
/* -------------------------------------------------------------------------- */

export interface EquityReport {
    contributions: number;
    withdrawals: number;
    net: number;
    movements: EquityMovement[];
}

export const listEquityMovements = async (filters: {
    from?: string;
    to?: string;
} = {}): Promise<EquityReport> => {
    const movements = await accountingRepo.listEquityMovements({
        ...(filters.from ? { from: new Date(filters.from) } : {}),
        ...(filters.to ? { to: new Date(filters.to) } : {}),
    });

    let contributionsCents = 0;
    let withdrawalsCents = 0;
    for (const movement of movements) {
        if (movement.type === 'contribution') {
            contributionsCents += toCents(movement.amount);
        } else {
            withdrawalsCents += toCents(movement.amount);
        }
    }

    return {
        contributions: fromCents(contributionsCents),
        withdrawals: fromCents(withdrawalsCents),
        net: fromCents(contributionsCents - withdrawalsCents),
        movements,
    };
};

export const createEquityMovement = async (
    input: {
        type: EquityMovement['type'];
        amount: number;
        occurredAt: string;
        partner: string;
        note?: string;
    },
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<EquityMovement> => {
    const occurredAt = new Date(input.occurredAt);
    await assertPeriodOpen(occurredAt, 'Movimiento de capital');

    const movement = await accountingRepo.createEquityMovement({
        ...input,
        occurredAt,
        createdBy: userId,
        ...(userLabel ? { createdByLabel: userLabel } : {}),
    });

    await recordAudit({
        action: 'equityMovement.created',
        entity: 'equityMovement',
        entityId: movement.id,
        summary: `${input.type === 'contribution' ? 'Aportación' : 'Retiro'} de ` +
            `${input.amount.toFixed(2)} de ${input.partner}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return movement;
};

/* -------------------------------------------------------------------------- */
/*  Gastos devengados                                                         */
/* -------------------------------------------------------------------------- */

export interface AccruedExpenseView extends AccruedExpense {
    balance: number;
    status: 'pending' | 'partial' | 'paid';
    isOverdue: boolean;
}

/** Saldo y estado **derivados**, igual que en las facturas de proveedor. */
const toAccruedView = (accrued: AccruedExpense, asOf: Date): AccruedExpenseView => {
    const balance = Math.round((accrued.amount - accrued.paidTotal) * 100) / 100;
    const status = balance <= 0.01 ? 'paid' : accrued.paidTotal > 0 ? 'partial' : 'pending';
    return {
        ...accrued,
        balance,
        status,
        isOverdue: status !== 'paid' &&
            !!accrued.dueDate &&
            accrued.dueDate.toDate() < asOf,
    };
};

export const listAccruedExpenses = async (filters: {
    from?: string;
    to?: string;
    onlyPending?: boolean;
} = {}): Promise<{ items: AccruedExpenseView[]; pendingTotal: number }> => {
    const asOf = new Date();
    const accrued = await accruedRepo.listAccrued({
        ...(filters.from ? { from: new Date(filters.from) } : {}),
        ...(filters.to ? { to: new Date(filters.to) } : {}),
    });

    const items = accrued
        .map((item) => toAccruedView(item, asOf))
        .filter((item) => !filters.onlyPending || item.status !== 'paid');

    return {
        items,
        pendingTotal: fromCents(
            items
                .filter((item) => item.status !== 'paid')
                .reduce((sum, item) => sum + toCents(item.balance), 0),
        ),
    };
};

/** Saldo total por pagar de gastos devengados; es un renglón del pasivo. */
export const getAccruedTotal = async (asOf: Date = new Date()): Promise<number> => {
    const accrued = await accruedRepo.listAccrued();
    return fromCents(
        accrued
            .map((item) => toAccruedView(item, asOf))
            .filter((item) => item.status !== 'paid')
            .reduce((sum, item) => sum + toCents(item.balance), 0),
    );
};

export const createAccruedExpense = async (
    input: {
        category: ExpenseCategory;
        concept: string;
        description?: string;
        amount: number;
        accruedAt: string;
        dueDate?: string;
    },
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<AccruedExpenseView> => {
    if (
        EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(input.category) &&
        !input.description?.trim()
    ) {
        throw badRequest('La descripción es requerida para esta categoría');
    }

    const accruedAt = new Date(input.accruedAt);
    // Pega en el resultado del periodo al que pertenece: no puede caer en uno
    // ya cerrado.
    await assertPeriodOpen(accruedAt, 'Gasto por pagar');

    const { dueDate, accruedAt: _ignored, ...rest } = input;
    const accrued = await accruedRepo.create({
        ...rest,
        accruedAt,
        ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
        createdBy: userId,
        ...(userLabel ? { createdByLabel: userLabel } : {}),
    });

    await recordAudit({
        action: 'accruedExpense.created',
        entity: 'accruedExpense',
        entityId: accrued.id,
        summary: `Gasto por pagar de ${input.amount.toFixed(2)} ` +
            `(${EXPENSE_CATEGORY_LABELS[input.category]}): ${input.concept}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return toAccruedView(accrued, new Date());
};

/**
 * Registra el pago de un gasto devengado. El movimiento sale como retiro de
 * efectivo, no como gasto: ver `accruedRepo.registerPayment`.
 */
export const payAccruedExpense = async (
    id: string,
    input: {
        amount: number;
        paymentMethod: ExpensePaymentMethod;
        paidAt?: string;
        bankAccountId?: string;
    },
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<AccruedExpenseView> => {
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    await assertPeriodOpen(paidAt, 'Pago de gasto');

    const current = await accruedRepo.getById(id);
    if (!current) {
        throw notFound('Gasto por pagar');
    }

    const { accrued } = await accruedRepo.registerPayment(id, {
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        paidAt,
        ...(input.bankAccountId ? { bankAccountId: input.bankAccountId } : {}),
        reason: `Pago de gasto devengado: ${current.concept}`,
        createdBy: userId,
        ...(userLabel ? { createdByLabel: userLabel } : {}),
    });

    const view = toAccruedView(accrued, new Date());

    await recordAudit({
        action: 'accruedExpense.paid',
        entity: 'accruedExpense',
        entityId: id,
        summary: `Pago de ${input.amount.toFixed(2)} al gasto "${current.concept}" ` +
            `(${input.paymentMethod}); saldo ${view.balance.toFixed(2)}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return view;
};
