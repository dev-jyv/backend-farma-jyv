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

/**
 * Etiquetas de las categorías de gasto, en el orden en que se presentan en los
 * reportes: primero los fijos y grandes (nómina, renta), al final los cajones
 * abiertos. Vive aquí para que el correo, el PDF y el POS digan lo mismo.
 */
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
    salary: 'Nómina',
    rent: 'Renta',
    electricity: 'Luz',
    supplier: 'Proveedores',
    supplies: 'Insumos',
    food: 'Alimentos',
    contingency: 'Imprevistos',
    other: 'Otros',
};

/** Orden estable para las tablas de gasto (no alfabético: por peso esperado). */
export const EXPENSE_CATEGORY_ORDER: ExpenseCategory[] = [
    'salary',
    'rent',
    'electricity',
    'supplier',
    'supplies',
    'food',
    'contingency',
    'other',
];
