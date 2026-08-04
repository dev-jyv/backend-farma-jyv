import {
    ControlledGroup,
    ControlledLedgerEntry,
    ControlledLedgerType,
    Product,
    SalePrescription,
} from '../types';
import { CONTROLLED_GROUP_RULES, getControlledRule } from '../constants/controlled';
import { badRequest } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { db } from '../utils/firestore';
import * as ledgerRepo from '../repositories/controlled-ledger.repository';

export const CONTROLLED_LEDGER_COLLECTION = 'controlledSalesLedger';

export interface ControlledRequirements {
    /** Grupos controlados presentes en la venta (los que exigen registro). */
    groups: ControlledGroup[];
    requiresPrescription: boolean;
    requiresFolio: boolean;
    requiresRetention: boolean;
    /** Grupos que deben quedar en el libro de control. */
    ledgerGroups: ControlledGroup[];
}

export const resolveControlledRequirements = (
    products: Array<Pick<Product, 'controlledGroup' | 'requiresPrescription'>>,
): ControlledRequirements => {
    const groups = new Set<ControlledGroup>();
    const ledgerGroups = new Set<ControlledGroup>();
    let requiresPrescription = false;
    let requiresFolio = false;
    let requiresRetention = false;

    for (const product of products) {
        const rule = getControlledRule(product.controlledGroup);
        if (!rule) {
            // Sin grupo capturado se respeta el flag suelto heredado del catálogo viejo.
            requiresPrescription = requiresPrescription || Boolean(product.requiresPrescription);
            continue;
        }
        groups.add(rule.group);
        requiresPrescription = requiresPrescription || rule.requiresPrescription;
        requiresFolio = requiresFolio || rule.requiresFolio;
        requiresRetention = requiresRetention || rule.retainsPrescription;
        if (rule.requiresLedger) {
            ledgerGroups.add(rule.group);
        }
    }

    return {
        groups: [...groups],
        requiresPrescription,
        requiresFolio,
        requiresRetention,
        ledgerGroups: [...ledgerGroups],
    };
};

/**
 * Valida receta y retención según los grupos vendidos. La retención es un acto
 * físico (la receta se queda en la farmacia), así que se exige que el cajero lo
 * confirme explícitamente: no se puede inferir del servidor.
 */
export const assertPrescriptionRules = (input: {
    requirements: ControlledRequirements;
    prescription?: SalePrescription;
    prescriptionRetained?: boolean;
}): void => {
    const { requirements, prescription } = input;

    if (requirements.requiresPrescription && !prescription) {
        const labels = requirements.groups
            .map((group) => CONTROLLED_GROUP_RULES[group].label)
            .join(', ');
        throw badRequest(
            labels
                ? `Esta venta incluye ${labels} y requiere datos de receta médica`
                : 'Esta venta requiere datos de receta médica',
        );
    }
    if (requirements.requiresFolio && !prescription?.folio) {
        throw badRequest(
            'Los medicamentos de los grupos I a III requieren el folio de la receta',
        );
    }
    if (requirements.requiresRetention && input.prescriptionRetained !== true) {
        throw badRequest(
            'Los medicamentos de los grupos I a III exigen retener la receta: ' +
            'confirma la retención (prescriptionRetained)',
        );
    }
};

export interface LedgerWriteInput {
    type: ControlledLedgerType;
    saleId: string;
    saleFolio: string;
    referenceFolio?: string | null;
    productId: string;
    productName: string;
    controlledGroup: ControlledGroup;
    /** Con signo: negativa cuando el producto regresa (anulación/devolución). */
    quantity: number;
    lotNumbers: string[];
    prescription: SalePrescription | null;
    prescriptionRetained: boolean;
    customerName: string | null;
    userId: string;
    createdAt: FirebaseFirestore.Timestamp;
}

/**
 * Escribe un movimiento del libro de control **dentro de la transacción** del caso
 * de uso: una unidad de estupefaciente que se movió sin renglón en el libro es
 * justo el hallazgo que sanciona COFEPRIS.
 */
export const writeLedgerEntryInTransaction = (
    transaction: FirebaseFirestore.Transaction,
    input: LedgerWriteInput,
): void => {
    const ref = db().collection(CONTROLLED_LEDGER_COLLECTION).doc();
    transaction.set(ref, {
        ...input,
        referenceFolio: input.referenceFolio ?? null,
    });
};

export const listControlledLedger = async (filters: {
    saleId?: string;
    productId?: string;
    group?: ControlledGroup;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: ControlledLedgerEntry[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    let entries = await ledgerRepo.listLedgerEntries(filters);

    if (filters.group) {
        entries = entries.filter((entry) => entry.controlledGroup === filters.group);
    }

    const paginated = paginate(entries, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};
