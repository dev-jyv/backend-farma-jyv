import {
    EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION,
    EXPENSE_CATEGORY_LABELS,
} from '../constants/expenses';
import * as accruedRepo from '../repositories/accrued-expenses.repository';
import * as recurringRepo from '../repositories/recurring-expenses.repository';
import {
    AccruedExpense,
    ExpenseCategory,
    ExpensePaymentMethod,
    RecurringExpense,
} from '../types';
import { badRequest, notFound } from '../utils/errors';
import { fromCents, toCents } from '../utils/taxes';
import { assertPeriodOpen } from './accounting-core.service';
import { recordAudit } from './audit.service';

/**
 * Gastos fijos: plantillas de renta, luz o nómina. La plantilla es solo el
 * presupuesto de referencia; en contabilidad pega únicamente lo que se registra
 * como pagado en su mes (`payRecurringExpense`), nunca el monto presupuestado.
 * Los gastos capturados en el POS no entran aquí: son la segunda caja.
 */

export interface RecurringMonthLine {
    recurringExpenseId: string;
    category: ExpenseCategory;
    concept: string;
    dueDay: number;
    isActive: boolean;
    budget: number;
    paid: number;
    lastPaymentAt: string | null;
}

export interface RecurringMonthSummary {
    month: string;
    lines: RecurringMonthLine[];
    budgetTotal: number;
    paidTotal: number;
    unpaidCount: number;
}

export const recurringAccrualId = (recurringExpenseId: string, month: string): string =>
    `recurring_${recurringExpenseId}_${month}`;

/**
 * El vencimiento es el día configurado a mediodía UTC: a medianoche UTC el día 1
 * caería, en hora de México, en el último día del mes anterior. El devengo es
 * ese mismo día salvo que aún no llegue; entonces es hoy, que sigue siendo del
 * mes (no se pagan meses futuros) y respeta la regla de no devengar a futuro.
 */
export const recurringAccrualDates = (
    month: string,
    dueDay: number,
    asOf: Date = new Date(),
): { accruedAt: Date; dueDate: Date } => {
    const dueDate = new Date(`${month}-${String(dueDay).padStart(2, '0')}T12:00:00.000Z`);
    return { dueDate, accruedAt: dueDate > asOf ? asOf : dueDate };
};

const sumMoney = (values: number[]): number =>
    fromCents(values.reduce((total, value) => total + toCents(value), 0));

/**
 * Presupuesto contra pagado de un mes. Entran las plantillas activas y también
 * las inactivas que ya tienen pagos ese mes: darla de baja no borra lo pagado.
 */
export const summarizeRecurringMonth = (
    month: string,
    templates: RecurringExpense[],
    accruals: AccruedExpense[],
): RecurringMonthSummary => {
    const accrualByTemplate = new Map(
        accruals.map((accrual) => [accrual.recurringExpenseId, accrual]),
    );
    const lines = templates
        .filter((template) =>
            template.isActive || (accrualByTemplate.get(template.id)?.paidTotal ?? 0) > 0)
        .map((template) => {
            const accrual = accrualByTemplate.get(template.id);
            return {
                recurringExpenseId: template.id,
                category: template.category,
                concept: template.concept,
                dueDay: template.dueDay,
                isActive: template.isActive,
                budget: template.isActive ? template.amount : 0,
                paid: accrual?.paidTotal ?? 0,
                lastPaymentAt: accrual?.lastPaymentAt?.toDate().toISOString() ?? null,
            };
        });

    return {
        month,
        lines,
        budgetTotal: sumMoney(lines.map((line) => line.budget)),
        paidTotal: sumMoney(lines.map((line) => line.paid)),
        unpaidCount: lines.filter((line) => line.isActive && line.paid <= 0).length,
    };
};

const assertDescription = (category: ExpenseCategory, description?: string | null): void => {
    if (EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(category) && !description?.trim()) {
        throw badRequest('La descripción es requerida para esta categoría');
    }
};

export const listRecurringExpenses = (): Promise<RecurringExpense[]> => recurringRepo.list();

export const getRecurringMonth = async (month: string): Promise<RecurringMonthSummary> => {
    const templates = await recurringRepo.list();
    const accruals = await accruedRepo.getByIds(
        templates.map((template) => recurringAccrualId(template.id, month)),
    );
    return summarizeRecurringMonth(month, templates, accruals);
};

export const createRecurringExpense = async (
    input: {
        category: ExpenseCategory;
        concept: string;
        description?: string;
        amount: number;
        dueDay: number;
    },
    userId: string,
    roleSlug: string,
): Promise<RecurringExpense> => {
    assertDescription(input.category, input.description);
    const template = await recurringRepo.create({ ...input, createdBy: userId });

    await recordAudit({
        action: 'recurringExpense.created',
        entity: 'recurringExpense',
        entityId: template.id,
        summary: `Gasto fijo de ${input.amount.toFixed(2)} ` +
            `(${EXPENSE_CATEGORY_LABELS[input.category]}): ${input.concept}`,
        userId,
        roleSlug,
        metadata: { ...input },
    });

    return template;
};

export const updateRecurringExpense = async (
    id: string,
    changes: Partial<{
        category: ExpenseCategory;
        concept: string;
        description: string;
        amount: number;
        dueDay: number;
        isActive: boolean;
    }>,
    userId: string,
    roleSlug: string,
): Promise<RecurringExpense> => {
    const current = await recurringRepo.getById(id);
    if (!current) {
        throw notFound('Gasto fijo');
    }
    assertDescription(
        changes.category ?? current.category,
        changes.description ?? current.description,
    );
    const template = await recurringRepo.update(id, changes, userId);

    await recordAudit({
        action: 'recurringExpense.updated',
        entity: 'recurringExpense',
        entityId: id,
        summary: `Gasto fijo actualizado: ${template.concept}`,
        userId,
        roleSlug,
        metadata: { before: current, changes },
    });

    return template;
};

/**
 * Registra un pago real del gasto fijo en su mes. Es lo único que lo lleva a
 * contabilidad; el pago sale como retiro del cajón o del banco elegido.
 */
export const payRecurringExpense = async (
    id: string,
    input: {
        month: string;
        amount: number;
        paymentMethod: ExpensePaymentMethod;
        paidAt?: string;
        bankAccountId?: string;
    },
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<RecurringMonthSummary> => {
    const template = await recurringRepo.getById(id);
    if (!template) {
        throw notFound('Gasto fijo');
    }
    const paidAt = input.paidAt ? new Date(`${input.paidAt}T12:00:00.000Z`) : new Date();
    const { accruedAt, dueDate } = recurringAccrualDates(input.month, template.dueDay);
    await assertPeriodOpen(accruedAt, `Gasto fijo ${template.concept}`);
    await assertPeriodOpen(paidAt, 'Pago de gasto fijo');

    const { accrued } = await accruedRepo.recordRecurringPayment(
        {
            id: recurringAccrualId(id, input.month),
            category: template.category,
            concept: template.concept,
            description: template.description ?? null,
            accruedAt,
            dueDate,
            recurringExpenseId: id,
            recurringMonth: input.month,
        },
        {
            amount: input.amount,
            paymentMethod: input.paymentMethod,
            paidAt,
            ...(input.bankAccountId ? { bankAccountId: input.bankAccountId } : {}),
            reason: `Pago de gasto fijo: ${template.concept} (${input.month})`,
            createdBy: userId,
            ...(userLabel ? { createdByLabel: userLabel } : {}),
        },
    );

    await recordAudit({
        action: 'recurringExpense.paid',
        entity: 'recurringExpense',
        entityId: id,
        summary: `Pago de ${input.amount.toFixed(2)} a ${template.concept} (${input.month}); ` +
            `pagado en el mes ${accrued.paidTotal.toFixed(2)}`,
        userId,
        roleSlug,
        metadata: { ...input, accruedExpenseId: accrued.id },
    });

    return getRecurringMonth(input.month);
};
