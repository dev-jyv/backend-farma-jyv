import { ExpenseCategory } from '../types';

/**
 * Categorías de gasto donde el motivo corto no basta y hay que describir en qué
 * se gastó. Vive aquí, y no dentro del esquema de alta, porque la corrección de
 * un gasto (`updateExpense`) tiene que aplicar **la misma** regla: si no, editar
 * un gasto a "Insumos" dejaría pasar algo que el alta habría rechazado.
 *
 * El POS replica esta lista en `shared/utils` / `electron/db/cash-movements.js`.
 */
export const EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION: ReadonlySet<ExpenseCategory> = new Set<
    ExpenseCategory
>(['supplies', 'supplier', 'other']);
