import {
    EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION,
    EXPENSE_CATEGORY_LABELS,
    EXPENSE_CATEGORY_ORDER,
} from '../constants/expenses';
import * as accountingRepo from '../repositories/accounting.repository';
import * as accruedRepo from '../repositories/accrued-expenses.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as cashMovementsRepo from '../repositories/cash-movements.repository';
import * as categoriesRepo from '../repositories/categories.repository';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as productsRepo from '../repositories/products.repository';
import * as suppliersRepo from '../repositories/suppliers.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as movementsRepo from '../repositories/stock-movements.repository';
import {
    AccruedExpense,
    CashMovement,
    ExpenseCategory,
    ExpensePaymentMethod,
    Sale,
    SaleReturn,
    isSaleProductItem,
    isSaleServiceItem,
} from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { fromCents, toCents } from '../utils/taxes';
import { recordAudit } from './audit.service';
import {
    assertPeriodOpen,
    depreciationInRangeCents,
    getAccruedTotal,
    listEquityMovements,
    listFixedAssets,
} from './accounting-core.service';
import { getBankTotal } from './bank.service';
import { settlementOf } from './invoices.service';

/**
 * Contabilidad (solo admin).
 *
 * **Fase 1**: estado de resultados completo y una posición financiera
 * deliberadamente **parcial**. El balance general no se publica como tal porque
 * el modelo de datos no tiene con qué cerrarlo —no existen bancos, cuentas por
 * pagar, cuentas por cobrar, activo fijo ni capital—, y un balance que no cuadra
 * es peor que no tener balance: invita a firmarlo.
 *
 * Todo el dinero se acumula en **centavos enteros** (`toCents`/`fromCents`) y
 * solo se convierte a pesos al devolver. Sumar flotantes renglón por renglón
 * deja un descuadre de centavos en la utilidad, que es justo la cifra que
 * alguien va a cuadrar contra otra fuente.
 *
 * Los ingresos se miden sobre la **base sin impuestos**: el IVA que cobra la
 * farmacia no es suyo, es del fisco, y contarlo como ingreso infla la utilidad.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  Estado de resultados                                                      */
/* -------------------------------------------------------------------------- */

export interface ExpenseLine {
    category: ExpenseCategory;
    label: string;
    total: number;
    count: number;
    /** Parte del renglón que salió del cajón de una caja. */
    fromCashBox: number;
    /** Parte capturada en contabilidad (transferencia, tarjeta, sin turno). */
    outsideCashBox: number;
    /** Parte **devengada y no pagada** al cierre del periodo. */
    accrued: number;
}

/**
 * Señales de qué tan completa está la cifra. Van en el informe, no en un log:
 * una utilidad calculada sobre ventas a las que les falta el costo es una
 * utilidad optimista, y quien la lee tiene que saberlo **en la misma pantalla**.
 */
export interface IncomeStatementReliability {
    /** Ventas del periodo con `costTotal` capturado. */
    salesWithCost: number;
    /** Ventas sin costo: su mercancía entra al ingreso y no al costo de ventas. */
    salesWithoutCost: number;
    /** Ventas anteriores al desglose de impuestos: su base se reconstruyó del neto. */
    salesWithoutTaxBreakdown: number;
    /** Devoluciones cuya venta original ya no se pudo leer para devolver el costo. */
    returnsWithoutCost: number;
    /** Lotes consumidos por merma sin costo capturado: la merma sale subestimada. */
    wasteWithoutCost: number;
    /** Gastos capturados en contabilidad (no salieron de ninguna caja). */
    expensesOutsideCashBox: number;
    /** Gastos devengados en el periodo: pegan en resultados sin haberse pagado. */
    accruedExpenses: number;
    /** Facturas de compra del periodo sin desglose: su IVA no es acreditable aquí. */
    invoicesWithoutTaxBreakdown: number;
    /** Avisos en español, listos para pintar. */
    warnings: string[];
}

export interface IncomeStatement {
    period: { from: string; to: string };
    revenue: {
        /** Base sin impuestos de la mercancía vendida. */
        pharmacy: number;
        /** Base sin impuestos de los servicios cobrados. */
        services: number;
        gross: number;
        /** Base sin impuestos de lo devuelto; se resta del bruto. */
        returns: number;
        net: number;
    };
    costOfSales: {
        /** Costo de la mercancía vendida, ya neto de lo devuelto. */
        merchandise: number;
        /** Costo de lo dado de baja por merma y caducidad en el periodo. */
        waste: number;
        total: number;
    };
    grossProfit: number;
    /** Margen bruto sobre el ingreso neto, en porcentaje. */
    grossMarginRate: number;
    operatingExpenses: {
        /** Comisiones devengadas por los doctores en el periodo. */
        commissions: number;
        /** Depreciación en línea recta del activo fijo, prorrateada al periodo. */
        depreciation: number;
        byCategory: ExpenseLine[];
        expensesTotal: number;
        total: number;
    };
    operatingIncome: number;
    /** Margen operativo sobre el ingreso neto, en porcentaje. */
    operatingMarginRate: number;
    /**
     * IVA del periodo por sus dos lados: el **trasladado** sale de las ventas y
     * el **acreditable** del desglose de las facturas de compra fechadas en el
     * periodo. `ivaPayable` es la diferencia —lo que se enteraría a Hacienda—, y
     * sale a favor cuando se compró más de lo que se vendió.
     *
     * El acreditable solo cuenta las facturas **con** desglose capturado; las
     * que no lo traen se reportan en `reliability.invoicesWithoutTaxBreakdown`,
     * porque su IVA existe y aquí se está dejando fuera.
     */
    taxes: {
        ivaCharged: number;
        iepsCharged: number;
        ivaCreditable: number;
        ivaPayable: number;
    };
    reliability: IncomeStatementReliability;
    /** Mismo cálculo sobre el periodo anterior de igual duración; solo si se pidió. */
    previous?: Omit<IncomeStatement, 'previous'>;
}

/** Porcentaje con dos decimales; 0 si la base no es positiva. */
const rate = (amountCents: number, baseCents: number): number =>
    baseCents <= 0 ? 0 : Math.round((amountCents / baseCents) * 10000) / 100;

/**
 * Base sin impuestos de una partida. Las ventas anteriores al desglose no traen
 * `taxes`, y ahí lo cobrado **incluye** el impuesto: se reconstruye del neto y
 * la venta se cuenta en `salesWithoutTaxBreakdown` para que el informe avise de
 * que ese tramo está sobrevaluado, en vez de callarlo.
 */
const lineBaseCents = (item: {
    taxes?: { base: number };
    netAmount?: number;
    subtotal: number;
    discountAmount: number;
}): number => {
    if (item.taxes) {
        return toCents(item.taxes.base);
    }
    return toCents(item.netAmount ?? item.subtotal - item.discountAmount);
};

/**
 * Costo unitario de una partida de mercancía, en centavos. `costAmount` es el
 * costo de **toda** la partida, así que devolver el costo de una devolución
 * parcial obliga a bajar a unidad.
 */
const unitCostCents = (item: {
    costAmount?: number | null;
    quantity: number;
}): number | null => {
    if (item.costAmount === null || item.costAmount === undefined || item.quantity <= 0) {
        return null;
    }
    return Math.round(toCents(item.costAmount) / item.quantity);
};

/** Costo de la mercancía que volvió por devolución, leído de su venta original. */
const returnedCostCents = async (
    returns: SaleReturn[],
): Promise<{ costCents: number; withoutCost: number }> => {
    if (returns.length === 0) {
        return { costCents: 0, withoutCost: 0 };
    }

    // Una venta puede tener varias devoluciones parciales: se lee una sola vez.
    const saleIds = [...new Set(returns.map((saleReturn) => saleReturn.saleId))];
    const sales = await Promise.all(saleIds.map((id) => salesRepo.getSaleById(id)));
    const saleById = new Map<string, Sale>();
    for (const sale of sales) {
        if (sale) {
            saleById.set(sale.id, sale);
        }
    }

    let costCents = 0;
    let withoutCost = 0;

    for (const saleReturn of returns) {
        const sale = saleById.get(saleReturn.saleId);
        for (const item of saleReturn.items) {
            const original = sale?.items
                .filter(isSaleProductItem)
                .find((line) => line.productId === item.productId);
            const unit = original ? unitCostCents(original) : null;
            if (unit === null) {
                withoutCost += 1;
                continue;
            }
            costCents += unit * item.quantity;
        }
    }

    return { costCents, withoutCost };
};

/**
 * Costo de lo dado de baja por merma y caducidad. El movimiento de stock guarda
 * cantidad y lote, no importe: el costo vive en el lote, así que hay que leerlos.
 * Un lote sin `costPrice` no puede valuarse y se cuenta en `wasteWithoutCost` —
 * la merma sale **subestimada**, nunca inventada.
 */
const wasteCostCents = async (
    filters: { from: string; to: string },
): Promise<{ costCents: number; withoutCost: number }> => {
    const [waste, expiry] = await Promise.all([
        movementsRepo.listStockMovements({ type: 'exit_waste', ...filters }),
        movementsRepo.listStockMovements({ type: 'exit_expiry', ...filters }),
    ]);
    const movements = [...waste, ...expiry];
    if (movements.length === 0) {
        return { costCents: 0, withoutCost: 0 };
    }

    const batchIds = [...new Set(movements.map((movement) => movement.batchId))];
    const batches = await Promise.all(batchIds.map((id) => batchesRepo.getBatchById(id)));
    const costByBatch = new Map<string, number | undefined>(
        batches
            .filter((batch): batch is NonNullable<typeof batch> => batch !== null)
            .map((batch) => [batch.id, batch.costPrice]),
    );

    let costCents = 0;
    let withoutCost = 0;

    for (const movement of movements) {
        const cost = costByBatch.get(movement.batchId);
        if (cost === undefined) {
            withoutCost += 1;
            continue;
        }
        // La cantidad de una salida se guarda en positivo; el signo lo pone el tipo.
        costCents += toCents(cost) * Math.abs(movement.quantity);
    }

    return { costCents, withoutCost };
};

/** Agrupa los gastos del periodo por categoría, en el orden fijo del catálogo. */
const groupExpenses = (
    movements: CashMovement[],
    accrued: AccruedExpense[],
): {
    lines: ExpenseLine[];
    totalCents: number;
    outsideCount: number;
    accruedCents: number;
} => {
    const byCategory = new Map<ExpenseCategory, {
        totalCents: number;
        count: number;
        fromCashBoxCents: number;
        outsideCents: number;
        accruedCents: number;
    }>();

    let totalCents = 0;
    let outsideCount = 0;
    let accruedCents = 0;

    for (const movement of movements) {
        // Solo `expense`: el pago de un gasto devengado viaja como `withdrawal`,
        // porque el gasto ya pegó en resultados el día que se devengó.
        if (movement.type !== 'expense') {
            continue;
        }
        // Un gasto sin categoría no debería existir (el alta la exige), pero un
        // documento viejo o importado puede no traerla: cae en "Otros" en vez de
        // desaparecer del total.
        const category = movement.category ?? 'other';
        const amountCents = toCents(movement.amount);
        // "Fuera de caja" es no haber salido del cajón: o no cuelga de un turno,
        // o se pagó por un medio que no es efectivo.
        const outside = movement.cashSessionId === null ||
            (movement.paymentMethod ?? 'cash') !== 'cash';

        const entry = byCategory.get(category) ??
            { totalCents: 0, count: 0, fromCashBoxCents: 0, outsideCents: 0, accruedCents: 0 };
        entry.totalCents += amountCents;
        entry.count += 1;
        if (outside) {
            entry.outsideCents += amountCents;
            outsideCount += 1;
        } else {
            entry.fromCashBoxCents += amountCents;
        }
        byCategory.set(category, entry);

        totalCents += amountCents;
    }

    // Los devengados del periodo pegan en resultados aunque no se hayan pagado:
    // es lo que vuelve comparable el estado de resultados con el de un despacho
    // contable, que trabaja siempre sobre lo causado.
    for (const item of accrued) {
        const amountCents = toCents(item.amount);
        const entry = byCategory.get(item.category) ??
            { totalCents: 0, count: 0, fromCashBoxCents: 0, outsideCents: 0, accruedCents: 0 };
        entry.totalCents += amountCents;
        entry.count += 1;
        entry.accruedCents += amountCents;
        byCategory.set(item.category, entry);

        totalCents += amountCents;
        accruedCents += amountCents;
    }

    const lines = EXPENSE_CATEGORY_ORDER
        .map((category) => {
            const entry = byCategory.get(category);
            return {
                category,
                label: EXPENSE_CATEGORY_LABELS[category],
                total: fromCents(entry?.totalCents ?? 0),
                count: entry?.count ?? 0,
                fromCashBox: fromCents(entry?.fromCashBoxCents ?? 0),
                outsideCashBox: fromCents(entry?.outsideCents ?? 0),
                accrued: fromCents(entry?.accruedCents ?? 0),
            };
        })
        // Los renglones en cero se quedan: un estado de resultados que esconde
        // "Renta: 0" no distingue "no se pagó" de "no se capturó".
        .filter((line) => line.count > 0 || line.total !== 0);

    return { lines, totalCents, outsideCount, accruedCents };
};

const buildWarnings = (
    reliability: Omit<IncomeStatementReliability, 'warnings'>,
): string[] => {
    const warnings: string[] = [];

    if (reliability.salesWithoutCost > 0) {
        warnings.push(
            `${reliability.salesWithoutCost} venta(s) del periodo no tienen costo capturado: ` +
            'su mercancía suma al ingreso pero no al costo de ventas, así que la utilidad ' +
            'mostrada es mayor que la real.',
        );
    }
    if (reliability.salesWithoutTaxBreakdown > 0) {
        warnings.push(
            `${reliability.salesWithoutTaxBreakdown} venta(s) son anteriores al desglose de ` +
            'impuestos: su base se reconstruyó del importe cobrado y puede incluir IVA.',
        );
    }
    if (reliability.returnsWithoutCost > 0) {
        warnings.push(
            `${reliability.returnsWithoutCost} partida(s) devuelta(s) no pudieron devolver su ` +
            'costo al inventario: el costo de ventas queda ligeramente alto.',
        );
    }
    if (reliability.wasteWithoutCost > 0) {
        warnings.push(
            `${reliability.wasteWithoutCost} baja(s) por merma o caducidad salieron de lotes sin ` +
            'costo: la merma está subestimada.',
        );
    }
    if (reliability.invoicesWithoutTaxBreakdown > 0) {
        warnings.push(
            `${reliability.invoicesWithoutTaxBreakdown} factura(s) de compra del periodo no ` +
            'tienen desglose de impuestos: su IVA no entra al acreditable, así que el IVA por ' +
            'pagar sale más alto que el real.',
        );
    }
    if (reliability.accruedExpenses > 0) {
        warnings.push(
            `Incluye ${reliability.accruedExpenses.toFixed(2)} de gastos devengados y todavía ` +
            'no pagados: pegan en el resultado del periodo y siguen vivos en el pasivo.',
        );
    }
    warnings.push(
        'No incluye provisión de ISR: el sistema no hace cálculo fiscal.',
    );

    return warnings;
};

const buildStatement = async (
    from: string,
    to: string,
): Promise<Omit<IncomeStatement, 'previous'>> => {
    const [{ items: sales }, returns, movements, invoices, assets, accrued] = await Promise.all([
        salesRepo.listSales({ from, to }),
        returnsRepo.listSaleReturns({ from, to }),
        cashMovementsRepo.listForPeriod({ from, to }),
        // Por fecha de factura, no de pago: el IVA se acredita cuando se compra.
        // La compra en sí no es gasto del periodo —entra al inventario y sale
        // como costo al venderse—, así que de aquí solo se usa el impuesto.
        invoicesRepo.listInvoices({ from, to }),
        // Con los dados de baja incluidos: un bien vendido a mitad del periodo
        // sí depreció la parte que estuvo en uso.
        accountingRepo.listFixedAssets({ includeDisposed: true }),
        // Gastos causados en el periodo aunque no se hayan pagado.
        accruedRepo.listAccrued({ from: new Date(from), to: new Date(to) }),
    ]);

    const depreciationCents = assets.reduce(
        (total, asset) => total + depreciationInRangeCents(asset, new Date(from), new Date(to)),
        0,
    );

    let ivaCreditableCents = 0;
    let invoicesWithoutTaxBreakdown = 0;
    for (const invoice of invoices) {
        if (!invoice.taxes) {
            invoicesWithoutTaxBreakdown += 1;
            continue;
        }
        ivaCreditableCents += toCents(invoice.taxes.ivaAmount);
    }

    let pharmacyBaseCents = 0;
    let servicesBaseCents = 0;
    let merchandiseCostCents = 0;
    let commissionCents = 0;
    let ivaCents = 0;
    let iepsCents = 0;
    let salesWithCost = 0;
    let salesWithoutCost = 0;
    let salesWithoutTaxBreakdown = 0;

    for (const sale of sales) {
        if (sale.costTotal === null || sale.costTotal === undefined) {
            salesWithoutCost += 1;
        } else {
            salesWithCost += 1;
        }
        if (!sale.taxSummary) {
            salesWithoutTaxBreakdown += 1;
        }

        ivaCents += toCents(sale.taxSummary?.ivaTotal ?? 0);
        iepsCents += toCents(sale.taxSummary?.iepsTotal ?? 0);
        commissionCents += toCents(sale.commissionTotal ?? 0);

        for (const item of sale.items) {
            if (isSaleProductItem(item)) {
                pharmacyBaseCents += lineBaseCents(item);
                merchandiseCostCents += toCents(item.costAmount ?? 0);
            } else if (isSaleServiceItem(item)) {
                servicesBaseCents += lineBaseCents(item);
            }
        }
    }

    const [returnedCost, waste] = await Promise.all([
        returnedCostCents(returns),
        wasteCostCents({ from, to }),
    ]);

    // Lo devuelto sale por los dos lados: del ingreso su base, del costo de
    // ventas el costo de la mercancía que volvió al anaquel. Restarlo solo del
    // ingreso convertiría cada devolución en una pérdida del tamaño del costo.
    const returnsBaseCents = returns.reduce(
        (total, saleReturn) => total + toCents(saleReturn.taxSummary.base),
        0,
    );
    merchandiseCostCents -= returnedCost.costCents;

    const grossRevenueCents = pharmacyBaseCents + servicesBaseCents;
    const netRevenueCents = grossRevenueCents - returnsBaseCents;
    const costOfSalesCents = merchandiseCostCents + waste.costCents;
    const grossProfitCents = netRevenueCents - costOfSalesCents;

    const expenses = groupExpenses(movements, accrued);
    const operatingExpensesCents = expenses.totalCents + commissionCents + depreciationCents;
    const operatingIncomeCents = grossProfitCents - operatingExpensesCents;

    const reliability: Omit<IncomeStatementReliability, 'warnings'> = {
        salesWithCost,
        salesWithoutCost,
        salesWithoutTaxBreakdown,
        returnsWithoutCost: returnedCost.withoutCost,
        wasteWithoutCost: waste.withoutCost,
        expensesOutsideCashBox: expenses.outsideCount,
        accruedExpenses: fromCents(expenses.accruedCents),
        invoicesWithoutTaxBreakdown,
    };

    return {
        period: { from, to },
        revenue: {
            pharmacy: fromCents(pharmacyBaseCents),
            services: fromCents(servicesBaseCents),
            gross: fromCents(grossRevenueCents),
            returns: fromCents(returnsBaseCents),
            net: fromCents(netRevenueCents),
        },
        costOfSales: {
            merchandise: fromCents(merchandiseCostCents),
            waste: fromCents(waste.costCents),
            total: fromCents(costOfSalesCents),
        },
        grossProfit: fromCents(grossProfitCents),
        grossMarginRate: rate(grossProfitCents, netRevenueCents),
        operatingExpenses: {
            commissions: fromCents(commissionCents),
            depreciation: fromCents(depreciationCents),
            byCategory: expenses.lines,
            expensesTotal: fromCents(expenses.totalCents),
            total: fromCents(operatingExpensesCents),
        },
        operatingIncome: fromCents(operatingIncomeCents),
        operatingMarginRate: rate(operatingIncomeCents, netRevenueCents),
        taxes: {
            ivaCharged: fromCents(ivaCents),
            iepsCharged: fromCents(iepsCents),
            ivaCreditable: fromCents(ivaCreditableCents),
            ivaPayable: fromCents(ivaCents - ivaCreditableCents),
        },
        reliability: { ...reliability, warnings: buildWarnings(reliability) },
    };
};

/**
 * Estado de resultados del periodo. Con `compare` agrega el periodo inmediato
 * anterior **de la misma duración** —no "el mes pasado"— para que comparar un
 * trimestre contra un mes no pase por comparable.
 */
export const getIncomeStatement = async (filters: {
    from: string;
    to: string;
    compare?: boolean;
}): Promise<IncomeStatement> => {
    const current = await buildStatement(filters.from, filters.to);

    if (!filters.compare) {
        return current;
    }

    const from = new Date(filters.from).getTime();
    const to = new Date(filters.to).getTime();
    const span = to - from;
    const previous = await buildStatement(
        new Date(from - span).toISOString(),
        new Date(from - 1).toISOString(),
    );

    return { ...current, previous };
};

/* -------------------------------------------------------------------------- */
/*  Posición financiera (parcial)                                             */
/* -------------------------------------------------------------------------- */

export interface FinancialPosition {
    /** Instante del corte; el inventario solo puede valuarse a hoy. */
    asOf: string;
    inventory: {
        total: number;
        /** Lotes con existencia y costo conocido. */
        batchesValued: number;
        /** Lotes con existencia y **sin** costo: no entran al valuado. */
        batchesWithoutCost: number;
        units: number;
        byCategory: Array<{
            categoryId: string;
            categoryName: string;
            units: number;
            total: number;
        }>;
    };
    /** Pasivo con proveedores: saldo de las facturas con control de pago. */
    payables: {
        total: number;
        overdueTotal: number;
        invoiceCount: number;
    };
    /**
     * Lo que este sistema **no** puede calcular, con el motivo. Va en la
     * respuesta y no en la documentación: la pantalla tiene que poder decir por
     * qué esto no es un balance general, o alguien lo va a leer como si lo fuera.
     */
    missing: Array<{ concept: string; reason: string }>;
}

/**
 * Faltantes para un balance general de verdad. Ver `FinancialPosition.missing`.
 *
 * Cuentas por cobrar **no** está en la lista: la farmacia cobra todo de contado,
 * así que el rubro no falta, no existe. Un faltante que nunca se va a llenar
 * solo entrena a leer la lista por encima.
 */
const MISSING_FOR_BALANCE_SHEET: FinancialPosition['missing'] = [
    {
        concept: 'Bancos',
        reason: 'No existe cuenta bancaria en el sistema; los cobros con tarjeta y ' +
            'transferencia no se concilian contra un saldo.',
    },
    {
        concept: 'Activo fijo y depreciación',
        reason: 'No hay catálogo de mobiliario ni equipo.',
    },
    {
        concept: 'Capital contable',
        reason: 'No hay aportaciones, retiros de socios ni resultados de ejercicios anteriores.',
    },
    {
        concept: 'Saldos iniciales',
        reason: 'No hay fecha de arranque contable con saldos de apertura por rubro: el ' +
            'sistema solo conoce lo ocurrido desde que se instaló.',
    },
];

/**
 * Posición financiera **parcial** a hoy. No es un balance general y no pretende
 * serlo: publica lo único que el modelo sí sostiene —el inventario valuado a
 * costo— junto con la lista explícita de lo que falta para cerrar un balance.
 *
 * Solo a hoy: valuar a una fecha pasada exigiría reconstruir la existencia de
 * cada lote moviendo `stockMovements` hacia atrás, y un inventario reconstruido
 * a medias es una cifra peor que ninguna.
 */
export const getFinancialPosition = async (): Promise<FinancialPosition> => {
    const [batches, products, categories, payables] = await Promise.all([
        batchesRepo.listBatchesWithStock(),
        productsRepo.listProducts({}),
        categoriesRepo.listCategories({}),
        getPayables(),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const categoryNameById = new Map<string, string>(
        categories.items.map((category) => [category.id, category.name]),
    );

    const byCategory = new Map<string, { units: number; totalCents: number }>();
    let totalCents = 0;
    let units = 0;
    let batchesValued = 0;
    let batchesWithoutCost = 0;

    for (const batch of batches) {
        if (batch.quantity <= 0) {
            continue;
        }
        units += batch.quantity;

        if (batch.costPrice === undefined || batch.costPrice === null) {
            batchesWithoutCost += 1;
            continue;
        }
        batchesValued += 1;

        const valueCents = toCents(batch.costPrice) * batch.quantity;
        totalCents += valueCents;

        const categoryId = productById.get(batch.productId)?.categoryId ?? '';
        const entry = byCategory.get(categoryId) ?? { units: 0, totalCents: 0 };
        entry.units += batch.quantity;
        entry.totalCents += valueCents;
        byCategory.set(categoryId, entry);
    }

    return {
        asOf: new Date().toISOString(),
        inventory: {
            total: fromCents(totalCents),
            batchesValued,
            batchesWithoutCost,
            units,
            byCategory: [...byCategory.entries()]
                .map(([categoryId, entry]) => ({
                    categoryId,
                    categoryName: categoryNameById.get(categoryId) ?? 'Sin categoría',
                    units: entry.units,
                    total: fromCents(entry.totalCents),
                }))
                .sort((a, b) => b.total - a.total),
        },
        payables: {
            total: payables.total,
            overdueTotal: payables.overdueTotal,
            invoiceCount: payables.invoiceCount,
        },
        missing: MISSING_FOR_BALANCE_SHEET,
    };
};

/* -------------------------------------------------------------------------- */
/*  Balance general                                                           */
/* -------------------------------------------------------------------------- */

export interface BalanceSheet {
    asOf: string;
    /** Fecha de arranque contable; `null` si aún no se captura. */
    startDate: string | null;
    assets: {
        /** Efectivo: apertura más el flujo en efectivo conocido. Estimado. */
        cash: number;
        /** Saldo de las cuentas bancarias; estimado solo si no hay cuentas dadas de alta. */
        bank: number;
        /** `true` mientras el renglón de bancos venga de una estimación. */
        bankIsEstimated: boolean;
        inventory: number;
        fixedAssetsGross: number;
        accumulatedDepreciation: number;
        fixedAssetsNet: number;
        total: number;
    };
    liabilities: {
        payables: number;
        /** Gastos devengados con saldo: causados y aún sin pagar. */
        accruedExpenses: number;
        /** IVA trasladado menos acreditable desde el arranque; a favor si sale negativo. */
        taxesPayable: number;
        total: number;
    };
    equity: {
        openingRetainedEarnings: number;
        contributions: number;
        withdrawals: number;
        /** Resultado acumulado desde el arranque contable hasta la fecha. */
        periodResult: number;
        total: number;
    };
    /**
     * Prueba de cuadre. El descuadre se **publica**: un balance que se cuadra
     * solo con una cifra de ajuste silenciosa es peor que no tenerlo, porque
     * nadie vuelve a buscar de dónde salió la diferencia.
     */
    check: { difference: number; balanced: boolean };
    /** Advertencias de qué partes son estimadas y por qué. */
    notes: string[];
}

/** Parte en efectivo de una venta; el resto entró por tarjeta o transferencia. */
const saleCashCents = (sale: Sale): number => {
    if (sale.cashAmount !== null && sale.cashAmount !== undefined) {
        return toCents(sale.cashAmount);
    }
    // Ventas anteriores a `cashAmount`: en efectivo es lo recibido menos el
    // cambio; en cualquier otro método, nada entró al cajón.
    if (sale.paymentMethod === 'cash') {
        return toCents((sale.amountReceived ?? sale.total) - (sale.change ?? 0));
    }
    return 0;
};

/**
 * Balance general a una fecha.
 *
 * **Efectivo y bancos son estimados** hasta que exista conciliación bancaria: se
 * arman con el saldo de apertura más el flujo que el sistema sí conoce (ventas,
 * devoluciones, gastos, abonos a proveedor). Un depósito o retiro entre caja y
 * banco se ve por un solo lado, porque nadie registra el otro. El descuadre
 * resultante sale publicado en `check`, no repartido a escondidas.
 */
export const getBalanceSheet = async (filters: { asOf?: string } = {}): Promise<BalanceSheet> => {
    const asOf = filters.asOf ? new Date(filters.asOf) : new Date();
    const settings = await accountingRepo.getSettings();
    const startDate = settings.startDate?.toDate() ?? null;
    const notes: string[] = [];

    // Sin fecha de arranque se toma el flujo completo que el sistema conoce; es
    // lo único honesto, y la nota lo dice para que nadie lo lea como un corte.
    const from = startDate ?? new Date(0);
    const fromIso = from.toISOString();
    const asOfIso = asOf.toISOString();

    const [
        sales, returns, movements, payments, equity, assets, position, statement, bank,
        accruedTotal,
    ] = await Promise.all([
        salesRepo.listSales({ from: fromIso, to: asOfIso }),
        returnsRepo.listSaleReturns({ from: fromIso, to: asOfIso }),
        cashMovementsRepo.listForPeriod({ from: fromIso, to: asOfIso }),
        invoicesRepo.listPaymentsForPeriod({ from, to: asOf }),
        listEquityMovements({ from: fromIso, to: asOfIso }),
        listFixedAssets({ includeDisposed: false, asOf: asOfIso }),
        getFinancialPosition(),
        buildStatement(fromIso, asOfIso),
        getBankTotal(asOf),
        getAccruedTotal(asOf),
    ]);

    let cashCents = toCents(settings.openingBalances.cash);
    let bankCents = toCents(settings.openingBalances.bank);

    for (const sale of sales.items) {
        const cash = saleCashCents(sale);
        cashCents += cash;
        // Lo que no entró al cajón entró por terminal o transferencia; sin
        // conciliación no se puede separar tarjeta de transferencia, y para el
        // balance las dos son el mismo renglón.
        bankCents += toCents(sale.total) - cash;
    }

    for (const saleReturn of returns) {
        const refund = toCents(saleReturn.refundTotal);
        if (saleReturn.refundMethod === 'cash') {
            cashCents -= refund;
        } else {
            bankCents -= refund;
        }
    }

    for (const movement of movements) {
        const amount = toCents(movement.amount);
        const byCash = (movement.paymentMethod ?? 'cash') === 'cash';
        if (movement.type === 'deposit') {
            cashCents += amount;
        } else if (byCash) {
            cashCents -= amount;
        } else {
            bankCents -= amount;
        }
    }

    for (const payment of payments) {
        // Las contrapartidas vienen en negativo y se suman solas.
        const amount = toCents(payment.amount);
        if (payment.paymentMethod === 'cash') {
            cashCents -= amount;
        } else {
            bankCents -= amount;
        }
    }

    // Con cuentas bancarias dadas de alta, el saldo real manda sobre el
    // estimado: la cuenta ya conoce su apertura, sus traspasos y lo que salió
    // por gastos y abonos. Mientras no exista ninguna, se conserva la
    // estimación, que es lo único disponible.
    const bankIsEstimated = bank.accountCount === 0;
    if (!bankIsEstimated) {
        bankCents = toCents(bank.total);
    }

    const inventoryCents = toCents(position.inventory.total);
    const fixedGrossCents = toCents(assets.totals.cost);
    const depreciationCents = toCents(assets.totals.accumulatedDepreciation) +
        toCents(settings.openingBalances.accumulatedDepreciation);
    const openingFixedCents = toCents(settings.openingBalances.fixedAssets);
    const fixedNetCents = fixedGrossCents + openingFixedCents - depreciationCents;

    const assetsTotalCents = cashCents + bankCents + inventoryCents + fixedNetCents;

    const payablesCents = toCents(position.payables.total);
    const accruedCents = toCents(accruedTotal);
    const taxesPayableCents = toCents(statement.taxes.ivaPayable);
    const liabilitiesTotalCents = payablesCents + accruedCents + taxesPayableCents;

    const contributionsCents = toCents(equity.contributions) +
        toCents(settings.openingBalances.equityContributions);
    const withdrawalsCents = toCents(equity.withdrawals);
    const retainedCents = toCents(settings.openingBalances.retainedEarnings);
    const resultCents = toCents(statement.operatingIncome);
    const equityTotalCents = contributionsCents - withdrawalsCents + retainedCents + resultCents;

    const differenceCents = assetsTotalCents - liabilitiesTotalCents - equityTotalCents;

    if (!startDate) {
        notes.push(
            'No hay fecha de arranque contable: el balance se arma con todo el historial ' +
            'del sistema y sin saldos de apertura, así que no corresponde a un corte real.',
        );
    }
    if (bankIsEstimated) {
        notes.push(
            'Bancos es un estimado: no hay cuentas bancarias dadas de alta, así que el saldo ' +
            'se calcula con el flujo que el sistema conoce. Da de alta las cuentas para que ' +
            'el renglón salga del saldo real.',
        );
    }
    notes.push(
        'El efectivo se calcula con el saldo de apertura más los movimientos registrados. ' +
        'Un retiro del cajón que no se capture como traspaso no se ve por ningún lado.',
    );
    if (filters.asOf && asOf < new Date()) {
        notes.push(
            'El inventario solo puede valuarse a hoy: el importe mostrado es el actual, ' +
            'no el que había a la fecha de corte.',
        );
    }
    if (Math.abs(differenceCents) > 100) {
        notes.push(
            'El balance no cuadra. La diferencia se muestra tal cual en vez de repartirse: ' +
            'suele venir de saldos de apertura incompletos o de traspasos entre caja y banco.',
        );
    }

    return {
        asOf: asOfIso,
        startDate: startDate?.toISOString() ?? null,
        assets: {
            cash: fromCents(cashCents),
            bank: fromCents(bankCents),
            bankIsEstimated,
            inventory: fromCents(inventoryCents),
            fixedAssetsGross: fromCents(fixedGrossCents + openingFixedCents),
            accumulatedDepreciation: fromCents(depreciationCents),
            fixedAssetsNet: fromCents(fixedNetCents),
            total: fromCents(assetsTotalCents),
        },
        liabilities: {
            payables: fromCents(payablesCents),
            accruedExpenses: fromCents(accruedCents),
            taxesPayable: fromCents(taxesPayableCents),
            total: fromCents(liabilitiesTotalCents),
        },
        equity: {
            openingRetainedEarnings: fromCents(retainedCents),
            contributions: fromCents(contributionsCents),
            withdrawals: fromCents(withdrawalsCents),
            periodResult: fromCents(resultCents),
            total: fromCents(equityTotalCents),
        },
        // Un peso de tolerancia: por debajo de eso es redondeo de centavos
        // repartido entre cientos de renglones, no un error de captura.
        check: {
            difference: fromCents(differenceCents),
            balanced: Math.abs(differenceCents) <= 100,
        },
        notes,
    };
};

/* -------------------------------------------------------------------------- */
/*  Cuentas por pagar                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Tramos de antigüedad del saldo. `current` es lo que todavía no vence y
 * `noDueDate` lo que no tiene plazo pactado —que no es lo mismo que estar al
 * corriente: es deuda de la que nadie sabe cuándo se cobra, y esconderla dentro
 * de "por vencer" haría creer que hay un calendario donde no lo hay.
 */
export type PayableBucket = 'noDueDate' | 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

const PAYABLE_BUCKET_LABELS: Record<PayableBucket, string> = {
    noDueDate: 'Sin vencimiento pactado',
    current: 'Por vencer',
    d1_30: 'Vencido 1 a 30 días',
    d31_60: 'Vencido 31 a 60 días',
    d61_90: 'Vencido 61 a 90 días',
    d90_plus: 'Vencido más de 90 días',
};

const PAYABLE_BUCKET_ORDER: PayableBucket[] = [
    'current',
    'noDueDate',
    'd1_30',
    'd31_60',
    'd61_90',
    'd90_plus',
];

export interface PayableInvoice {
    id: string;
    invoiceNumber: string;
    supplierId: string;
    supplierName: string;
    invoiceDate: string;
    dueDate: string | null;
    totalAmount: number;
    paidTotal: number;
    balance: number;
    isOverdue: boolean;
    /** Días vencidos; `null` si no hay plazo pactado o aún no vence. */
    daysOverdue: number | null;
    bucket: PayableBucket;
}

export interface PayablesReport {
    asOf: string;
    total: number;
    overdueTotal: number;
    invoiceCount: number;
    buckets: Array<{ bucket: PayableBucket; label: string; total: number; count: number }>;
    bySupplier: Array<{
        supplierId: string;
        supplierName: string;
        total: number;
        overdueTotal: number;
        invoiceCount: number;
        oldestDueDate: string | null;
    }>;
    invoices: PayableInvoice[];
}

const bucketOf = (daysOverdue: number | null): PayableBucket => {
    if (daysOverdue === null) {
        return 'noDueDate';
    }
    if (daysOverdue <= 0) {
        return 'current';
    }
    if (daysOverdue <= 30) {
        return 'd1_30';
    }
    if (daysOverdue <= 60) {
        return 'd31_60';
    }
    if (daysOverdue <= 90) {
        return 'd61_90';
    }
    return 'd90_plus';
};

/**
 * Saldo a proveedores por antigüedad.
 *
 * Solo las facturas **con control de saldo**: las anteriores a este módulo se
 * dan por saldadas (ver `InvoicePaymentStatus`), porque tratarlas como
 * pendientes haría aparecer, el día del despliegue, una deuda falsa del tamaño
 * de todo lo comprado en la historia del sistema.
 */
export const getPayables = async (): Promise<PayablesReport> => {
    const asOf = new Date();
    const tracked = await invoicesRepo.listTrackedInvoices();

    const pending = tracked
        .map((invoice) => ({ invoice, settlement: settlementOf(invoice, asOf) }))
        .filter(({ settlement }) => settlement.balance > 0);

    const suppliers = await suppliersRepo.getSuppliersByIds(
        pending.map(({ invoice }) => invoice.supplierId),
    );

    const invoices: PayableInvoice[] = pending.map(({ invoice, settlement }) => {
        const dueDate = invoice.dueDate?.toDate() ?? null;
        const daysOverdue = dueDate
            ? Math.floor((asOf.getTime() - dueDate.getTime()) / MS_PER_DAY)
            : null;

        return {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            supplierId: invoice.supplierId,
            supplierName: suppliers.get(invoice.supplierId)?.name ?? 'Proveedor desconocido',
            invoiceDate: invoice.invoiceDate.toDate().toISOString(),
            dueDate: dueDate?.toISOString() ?? null,
            totalAmount: invoice.totalAmount,
            paidTotal: invoice.paidTotal ?? 0,
            balance: settlement.balance,
            isOverdue: settlement.isOverdue,
            // Solo se reportan los días cuando de verdad hay atraso: un -12 en
            // una columna llamada "días vencidos" se lee como un error.
            daysOverdue: daysOverdue !== null && daysOverdue > 0 ? daysOverdue : null,
            bucket: bucketOf(daysOverdue),
        };
    });

    const byBucket = new Map<PayableBucket, { totalCents: number; count: number }>();
    const bySupplier = new Map<string, {
        supplierName: string;
        totalCents: number;
        overdueCents: number;
        invoiceCount: number;
        oldestDueDate: string | null;
    }>();

    let totalCents = 0;
    let overdueCents = 0;

    for (const invoice of invoices) {
        const balanceCents = toCents(invoice.balance);
        totalCents += balanceCents;
        if (invoice.isOverdue) {
            overdueCents += balanceCents;
        }

        const bucket = byBucket.get(invoice.bucket) ?? { totalCents: 0, count: 0 };
        bucket.totalCents += balanceCents;
        bucket.count += 1;
        byBucket.set(invoice.bucket, bucket);

        const supplier = bySupplier.get(invoice.supplierId) ?? {
            supplierName: invoice.supplierName,
            totalCents: 0,
            overdueCents: 0,
            invoiceCount: 0,
            oldestDueDate: null,
        };
        supplier.totalCents += balanceCents;
        supplier.invoiceCount += 1;
        if (invoice.isOverdue) {
            supplier.overdueCents += balanceCents;
        }
        if (
            invoice.dueDate &&
            (supplier.oldestDueDate === null || invoice.dueDate < supplier.oldestDueDate)
        ) {
            supplier.oldestDueDate = invoice.dueDate;
        }
        bySupplier.set(invoice.supplierId, supplier);
    }

    return {
        asOf: asOf.toISOString(),
        total: fromCents(totalCents),
        overdueTotal: fromCents(overdueCents),
        invoiceCount: invoices.length,
        buckets: PAYABLE_BUCKET_ORDER.map((bucket) => ({
            bucket,
            label: PAYABLE_BUCKET_LABELS[bucket],
            total: fromCents(byBucket.get(bucket)?.totalCents ?? 0),
            count: byBucket.get(bucket)?.count ?? 0,
        })),
        bySupplier: [...bySupplier.entries()]
            .map(([supplierId, entry]) => ({
                supplierId,
                supplierName: entry.supplierName,
                total: fromCents(entry.totalCents),
                overdueTotal: fromCents(entry.overdueCents),
                invoiceCount: entry.invoiceCount,
                oldestDueDate: entry.oldestDueDate,
            }))
            .sort((a, b) => b.total - a.total),
        // Lo vencido primero y, dentro de eso, lo más viejo: es el orden en el
        // que hay que pagar, no el orden en el que se capturó.
        invoices: invoices.sort((a, b) => {
            if (a.isOverdue !== b.isOverdue) {
                return a.isOverdue ? -1 : 1;
            }
            return (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0);
        }),
    };
};

/* -------------------------------------------------------------------------- */
/*  Gastos fuera de caja                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Registra un gasto que **no salió del cajón**: nómina, renta o luz pagadas por
 * transferencia. Nace con `cashSessionId: null`, así que `buildSummary` —que
 * filtra por sesión— lo deja fuera de todo corte por sí solo: capturar la nómina
 * aquí no puede descuadrarle la caja a nadie.
 *
 * Se audita siempre. Es dinero que sale de la farmacia sin ticket de caja que lo
 * respalde, exactamente el caso que la bitácora existe para rastrear.
 */
export const createExpense = async (
    userId: string,
    roleSlug: string,
    userLabel: string | undefined,
    input: {
        amount: number;
        reason: string;
        category: ExpenseCategory;
        description?: string;
        paymentMethod: ExpensePaymentMethod;
        /** Cuenta de la que salió; solo aplica si no fue en efectivo. */
        bankAccountId?: string;
        occurredAt?: string;
    },
): Promise<CashMovement> => {
    if (
        EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(input.category) &&
        !input.description?.trim()
    ) {
        throw badRequest('La descripción es requerida para esta categoría');
    }

    // El gasto se fecha a mano, así que puede caer en un mes ya reportado: sin
    // esta comprobación, un estado de resultados firmado cambia de cifra.
    await assertPeriodOpen(
        input.occurredAt ? new Date(input.occurredAt) : new Date(),
        'Gasto',
    );

    const movement = await cashMovementsRepo.createMovement({
        cashSessionId: null,
        type: 'expense',
        amount: input.amount,
        reason: input.reason.trim(),
        category: input.category,
        description: input.description?.trim() || undefined,
        paymentMethod: input.paymentMethod,
        // Un gasto en efectivo no sale de ninguna cuenta: guardar la cuenta ahí
        // haría que el saldo bancario bajara por dinero que salió del cajón.
        ...(input.paymentMethod !== 'cash' && input.bankAccountId
            ? { bankAccountId: input.bankAccountId }
            : {}),
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        createdBy: userId,
        createdByLabel: userLabel,
    });

    await recordAudit({
        action: 'cashMovement.created',
        entity: 'cashMovement',
        entityId: movement.id,
        summary: `Gasto de contabilidad por ${input.amount.toFixed(2)} ` +
            `(${EXPENSE_CATEGORY_LABELS[input.category]}, ${input.paymentMethod}): ` +
            input.reason.trim(),
        userId,
        roleSlug,
        metadata: {
            amount: input.amount,
            category: input.category,
            paymentMethod: input.paymentMethod,
            occurredAt: input.occurredAt ?? null,
        },
    });

    return movement;
};

/**
 * Corrige un gasto de contabilidad. **Solo los suyos**: un gasto que cuelga de
 * un turno se corrige desde el POS, que sabe si el turno sigue abierto y vuelve
 * a calcular el efectivo esperado del corte. Editarlo desde aquí reescribiría un
 * corte ya cerrado sin pasar por esa comprobación.
 */
export const updateExpense = async (
    movementId: string,
    userId: string,
    roleSlug: string,
    patch: {
        amount?: number;
        reason?: string;
        category?: ExpenseCategory;
        description?: string;
        paymentMethod?: ExpensePaymentMethod;
        occurredAt?: string;
    },
): Promise<CashMovement> => {
    const movement = await cashMovementsRepo.getMovementById(movementId);
    if (!movement || movement.type !== 'expense') {
        throw notFound('Gasto');
    }
    if (movement.cashSessionId !== null) {
        throw badRequest(
            'Este gasto pertenece a un turno de caja: se corrige desde el punto de venta',
        );
    }

    // La descripción obligatoria se valida contra la categoría **resultante**,
    // igual que en el POS: cambiar a "Insumos" sin describir dejaría pasar algo
    // que el alta habría rechazado.
    const category = patch.category ?? movement.category ?? undefined;
    const description = patch.description ?? movement.description ?? undefined;
    if (
        category !== undefined &&
        EXPENSE_CATEGORIES_REQUIRING_DESCRIPTION.has(category) &&
        !description?.trim()
    ) {
        throw badRequest('La descripción es requerida para esta categoría');
    }

    // Las dos fechas importan: no se puede sacar un gasto de un periodo cerrado
    // ni meterlo en uno, así que se comprueban la de origen y la de destino.
    await assertPeriodOpen(cashMovementsRepo.effectiveDate(movement), 'Gasto');
    if (patch.occurredAt) {
        await assertPeriodOpen(new Date(patch.occurredAt), 'Gasto');
    }

    const updated = await cashMovementsRepo.updateMovement(movementId, {
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason.trim() } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.description !== undefined
            ? { description: patch.description.trim() || null }
            : {}),
        ...(patch.paymentMethod !== undefined ? { paymentMethod: patch.paymentMethod } : {}),
        ...(patch.occurredAt !== undefined ? { occurredAt: new Date(patch.occurredAt) } : {}),
    });

    await recordAudit({
        action: 'cashMovement.updated',
        entity: 'cashMovement',
        entityId: movementId,
        summary: `Gasto de contabilidad corregido: ${updated.reason} ` +
            `(${updated.amount.toFixed(2)})`,
        userId,
        roleSlug,
        metadata: { patch },
    });

    return updated;
};

/**
 * Gastos del periodo, por **fecha de ocurrencia**. Incluye por defecto los dos
 * orígenes —cajón y contabilidad—, porque es exactamente lo que el estado de
 * resultados suma: una lista que solo mostrara uno de los dos no cuadraría
 * nunca con el informe que está al lado.
 */
export const listExpenses = async (filters: {
    from?: string;
    to?: string;
    category?: ExpenseCategory;
    paymentMethod?: ExpensePaymentMethod;
    origin?: 'outside' | 'cashbox';
    page?: number;
    limit?: number;
    /**
     * Sube el tope de 100 por página. Solo lo usa la exportación: un auxiliar de
     * gastos recortado a 100 renglones es peor que uno grande, porque el
     * contador no tiene cómo notar que le faltan movimientos.
     */
    maxLimit?: number;
}): Promise<{ items: CashMovement[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit, {
        ...(filters.maxLimit ? { maxLimit: filters.maxLimit } : {}),
    });
    const to = filters.to ?? new Date().toISOString();
    const from = filters.from ??
        new Date(new Date(to).getTime() - 30 * MS_PER_DAY).toISOString();

    let movements = (await cashMovementsRepo.listForPeriod({ from, to }))
        .filter((movement) => movement.type === 'expense');

    if (filters.category) {
        movements = movements.filter((movement) => movement.category === filters.category);
    }
    if (filters.paymentMethod) {
        movements = movements.filter(
            (movement) => (movement.paymentMethod ?? 'cash') === filters.paymentMethod,
        );
    }
    if (filters.origin) {
        movements = movements.filter((movement) =>
            filters.origin === 'outside'
                ? movement.cashSessionId === null
                : movement.cashSessionId !== null,
        );
    }

    // Por fecha de ocurrencia, no de captura: es el orden en el que se leen en
    // el informe, y ordenar por captura mezcla la renta de marzo entre abril.
    movements.sort(
        (a, b) =>
            cashMovementsRepo.effectiveDate(b).getTime() -
            cashMovementsRepo.effectiveDate(a).getTime(),
    );

    const { items, total } = paginate(movements, page, limit);
    return { items, meta: buildListMeta(page, limit, total) };
};
