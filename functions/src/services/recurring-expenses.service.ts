import {
    EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION,
    EXPENSE_CATEGORY_LABELS,
} from '../constants/expenses';
import * as accruedRepo from '../repositories/accrued-expenses.repository';
import * as recurringRepo from '../repositories/recurring-expenses.repository';
import { ExpenseCategory, RecurringExpense } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { fromCents, toCents } from '../utils/taxes';
import { AccruedExpenseView, assertPeriodOpen, toAccruedView } from './accounting-core.service';
import { recordAudit } from './audit.service';

/**
 * Gastos fijos: plantillas que, a pedido, generan un gasto devengado por mes.
 *
 * La generación es idempotente por construcción: el devengado de una plantilla
 * en un mes tiene id `recurring_<plantilla>_<mes>`, así que generar dos veces
 * (o desde dos pantallas a la vez) nunca duplica el gasto del estado de
 * resultados.
 */

export interface RecurringMonthLine {
    recurringExpenseId: string;
    category: ExpenseCategory;
    concept: string;
    dueDay: number;
    isActive: boolean;
    budget: number;
    accrued: AccruedExpenseView | null;
}

export interface RecurringMonthSummary {
    month: string;
    lines: RecurringMonthLine[];
    budgetTotal: number;
    accruedTotal: number;
    paidTotal: number;
    pendingToGenerate: number;
}

export const recurringAccrualId = (recurringExpenseId: string, month: string): string =>
    `recurring_${recurringExpenseId}_${month}`;

/**
 * El vencimiento es el día configurado a mediodía UTC: a medianoche UTC el día 1
 * caería, en hora de México, en el último día del mes anterior. El devengo es
 * ese mismo día salvo que aún no llegue; entonces es hoy, que sigue siendo del
 * mes (no se generan meses futuros) y respeta la regla de no devengar a futuro.
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
 * Presupuesto contra real de un mes. Entran las plantillas activas y también
 * las inactivas que ya generaron gasto ese mes: darla de baja no borra lo que
 * ya pegó en resultados.
 */
export const summarizeRecurringMonth = (
    month: string,
    templates: RecurringExpense[],
    accruals: AccruedExpenseView[],
): RecurringMonthSummary => {
    const accrualByTemplate = new Map(
        accruals.map((accrual) => [accrual.recurringExpenseId, accrual]),
    );
    const lines = templates
        .filter((template) => template.isActive || accrualByTemplate.has(template.id))
        .map((template) => ({
            recurringExpenseId: template.id,
            category: template.category,
            concept: template.concept,
            dueDay: template.dueDay,
            isActive: template.isActive,
            budget: template.isActive ? template.amount : 0,
            accrued: accrualByTemplate.get(template.id) ?? null,
        }));
    const accrued = lines.flatMap((line) => (line.accrued ? [line.accrued] : []));

    return {
        month,
        lines,
        budgetTotal: sumMoney(lines.map((line) => line.budget)),
        accruedTotal: sumMoney(accrued.map((item) => item.amount)),
        paidTotal: sumMoney(accrued.map((item) => item.paidTotal)),
        pendingToGenerate: lines.filter((line) => line.isActive && !line.accrued).length,
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
    const asOf = new Date();
    return summarizeRecurringMonth(
        month,
        templates,
        accruals.map((accrual) => toAccruedView(accrual, asOf)),
    );
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

export const generateRecurringMonth = async (
    month: string,
    userId: string,
    roleSlug: string,
    userLabel?: string,
): Promise<{ created: number; existing: number; summary: RecurringMonthSummary }> => {
    const templates = (await recurringRepo.list()).filter((template) => template.isActive);
    if (templates.length === 0) {
        throw badRequest('No hay gastos fijos activos');
    }

    const asOf = new Date();
    const entries = templates.map((template) => ({
        id: recurringAccrualId(template.id, month),
        category: template.category,
        concept: template.concept,
        description: template.description ?? null,
        amount: template.amount,
        ...recurringAccrualDates(month, template.dueDay, asOf),
        recurringExpenseId: template.id,
        recurringMonth: month,
    }));

    const existingIds = new Set(
        (await accruedRepo.getByIds(entries.map((entry) => entry.id))).map((item) => item.id),
    );
    const pending = entries.filter((entry) => !existingIds.has(entry.id));
    for (const entry of pending) {
        await assertPeriodOpen(entry.accruedAt, `Gasto fijo ${entry.concept}`);
    }

    const result = await accruedRepo.createRecurringAccruals(pending, userId, userLabel);

    if (result.created.length > 0) {
        await recordAudit({
            action: 'recurringExpense.generated',
            entity: 'recurringExpense',
            entityId: month,
            summary: `Gastos fijos de ${month}: ${result.created.length} generados por ` +
                sumMoney(result.created.map((item) => item.amount)).toFixed(2),
            userId,
            roleSlug,
            metadata: { month, accruedIds: result.created.map((item) => item.id) },
        });
    }

    return {
        created: result.created.length,
        existing: existingIds.size + result.existingIds.length,
        summary: await getRecurringMonth(month),
    };
};
