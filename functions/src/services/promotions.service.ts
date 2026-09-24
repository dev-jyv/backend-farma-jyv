import { Timestamp } from 'firebase-admin/firestore';
import { Promotion, PromotionRule } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import { now, toTimestamp } from '../utils/firestore';
import { computePromotionDiscount, isPromotionMonotonic } from '../utils/promotions';
import * as promotionsRepo from '../repositories/promotions.repository';
import * as productsRepo from '../repositories/products.repository';
import { AuditActor, diffFields, recordAudit } from './audit.service';

const RULE_LABELS: Record<PromotionRule['type'], string> = {
    tiered: 'precio por cantidad',
    nxm: 'lleva N paga M',
    percent: 'porcentaje',
};

export const listPromotions = async (filters: {
    activeOnly?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Promotion[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await promotionsRepo.listPromotionsPage({
        activeOnly: filters.activeOnly,
        search: filters.search?.trim() || undefined,
        page,
        limit,
    });
    return { items, meta: buildListMeta(page, limit, total) };
};

/**
 * Promoción tal como la guarda el SQLite del POS: lo necesario para aplicarla
 * sin red, sin la bitácora de autoría.
 */
export interface SyncPromotion {
    id: string;
    name: string;
    rule: PromotionRule;
    productIds: string[];
    startsAt: Timestamp;
    endsAt: Timestamp | null;
    isActive: boolean;
    deactivatedAt: Timestamp | null;
    updatedAt: Timestamp;
}

const toSyncPromotion = (promotion: Promotion): SyncPromotion => ({
    id: promotion.id,
    name: promotion.name,
    rule: promotion.rule,
    productIds: promotion.productIds,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    isActive: promotion.isActive,
    deactivatedAt: promotion.deactivatedAt,
    updatedAt: promotion.updatedAt,
});

/** Incluye inactivas a propósito: la caja necesita enterarse de las bajas. */
export const listPromotionsForSync = async (filters: {
    updatedSince?: string;
}): Promise<{ items: SyncPromotion[] }> => {
    const promotions = await promotionsRepo.listPromotions({
        updatedSince: filters.updatedSince,
    });
    return { items: promotions.map(toSyncPromotion) };
};

export const getPromotion = async (id: string): Promise<Promotion> => {
    const promotion = await promotionsRepo.getPromotionById(id);
    if (!promotion) {
        throw notFound('Promoción');
    }
    return promotion;
};

/**
 * Los productos deben existir y estar activos, y la regla debe dar un descuento
 * real sobre el precio de lista de **cada** uno: un "2 por $80" sobre un producto
 * de $35 no es promoción, es un error de captura que nunca se aplicaría.
 */
const assertRuleFitsProducts = async (
    rule: PromotionRule,
    productIds: string[],
): Promise<void> => {
    const products = await Promise.all(productIds.map((id) => productsRepo.getProductById(id)));
    products.forEach((product, index) => {
        if (!product) {
            throw badRequest(`El producto ${productIds[index]} no existe`);
        }
        if (!product.isActive) {
            throw badRequest(`El producto ${product.name} está inactivo`);
        }
        if (rule.type === 'tiered') {
            for (const tier of rule.tiers) {
                if (tier.price >= tier.quantity * product.salePrice) {
                    throw badRequest(
                        `${tier.quantity} piezas por $${tier.price} no es menor al precio ` +
                        `normal de ${product.name} ($${product.salePrice} c/u)`,
                    );
                }
            }
        }
        const maxQty = rule.type === 'tiered'
            ? Math.max(...rule.tiers.map((tier) => tier.quantity))
            : rule.type === 'nxm' ? rule.buy : rule.minQty;
        if (computePromotionDiscount(rule, product.salePrice, maxQty) <= 0) {
            throw badRequest(`La promoción no da descuento sobre ${product.name}`);
        }
        if (!isPromotionMonotonic(rule, product.salePrice)) {
            throw badRequest(
                `Con esta promoción, llevar más piezas de ${product.name} costaría menos ` +
                'que llevar menos; ajusta el precio o la cantidad',
            );
        }
    });
};

export const createPromotion = async (
    input: {
        name: string;
        description?: string;
        rule: PromotionRule;
        productIds: string[];
        startsAt?: string;
        endsAt?: string | null;
    },
    actor: AuditActor,
): Promise<Promotion> => {
    await assertRuleFitsProducts(input.rule, input.productIds);

    const promotion = await promotionsRepo.createPromotion({
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
        rule: input.rule,
        productIds: input.productIds,
        startsAt: input.startsAt ? toTimestamp(input.startsAt) : now(),
        endsAt: input.endsAt ? toTimestamp(input.endsAt) : null,
        isActive: true,
        deactivatedAt: null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
    });

    await recordAudit({
        action: 'promotion.created',
        entity: 'promotion',
        entityId: promotion.id,
        summary: `Promoción "${promotion.name}" (${RULE_LABELS[promotion.rule.type]}) ` +
            `en ${promotion.productIds.length} producto(s)`,
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        metadata: { rule: promotion.rule, productIds: promotion.productIds },
    });
    return promotion;
};

const millisOrNull = (value: Timestamp | null | undefined): number | null =>
    value ? value.toMillis() : null;

export const updatePromotion = async (
    id: string,
    input: Partial<{
        name: string;
        description: string;
        startsAt: string;
        endsAt: string | null;
        isActive: boolean;
    }>,
    actor: AuditActor,
): Promise<Promotion> => {
    const existing = await promotionsRepo.getPromotionById(id);
    if (!existing) {
        throw notFound('Promoción');
    }

    const startsAt = input.startsAt ? toTimestamp(input.startsAt) : undefined;
    const endsAt = input.endsAt === undefined
        ? undefined
        : input.endsAt === null ? null : toTimestamp(input.endsAt);
    const effectiveStart = startsAt ?? existing.startsAt;
    const effectiveEnd = endsAt === undefined ? existing.endsAt : endsAt;
    if (effectiveEnd && effectiveEnd.toMillis() <= effectiveStart.toMillis()) {
        throw badRequest('La fecha de fin debe ser posterior a la de inicio');
    }
    // Reactivar revive la regla contra el catálogo de **hoy**: el precio pudo
    // bajar o el producto darse de baja mientras estuvo apagada.
    if (input.isActive === true && !existing.isActive) {
        await assertRuleFitsProducts(existing.rule, existing.productIds);
    }

    const { before, after } = await promotionsRepo.updatePromotion(id, {
        name: input.name?.trim(),
        description: input.description?.trim(),
        startsAt,
        endsAt,
        isActive: input.isActive,
        updatedBy: actor.userId,
    });

    const changes = diffFields(
        {
            name: before.name,
            description: before.description,
            startsAt: millisOrNull(before.startsAt),
            endsAt: millisOrNull(before.endsAt),
            isActive: before.isActive,
        } as Record<string, unknown>,
        {
            name: after.name,
            description: after.description,
            startsAt: millisOrNull(after.startsAt),
            endsAt: millisOrNull(after.endsAt),
            isActive: after.isActive,
        },
        ['name', 'description', 'startsAt', 'endsAt', 'isActive'],
    );
    if (changes) {
        const deactivated = before.isActive && !after.isActive;
        const reactivated = !before.isActive && after.isActive;
        await recordAudit({
            action: deactivated
                ? 'promotion.deactivated'
                : reactivated ? 'promotion.reactivated' : 'promotion.updated',
            entity: 'promotion',
            entityId: id,
            summary: deactivated
                ? `Promoción "${before.name}" dada de baja`
                : reactivated
                    ? `Promoción "${before.name}" reactivada`
                    : `Promoción "${before.name}" modificada`,
            userId: actor.userId,
            roleSlug: actor.roleSlug,
            changes,
        });
    }
    return after;
};

/** Baja lógica: las partidas vendidas guardan copia de la regla, pero no se borra. */
export const deletePromotion = async (id: string, actor: AuditActor): Promise<Promotion> =>
    updatePromotion(id, { isActive: false }, actor);
