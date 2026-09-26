import { Timestamp } from 'firebase-admin/firestore';
import {
    ExpiringPromotionSuggestion,
    Product,
    Promotion,
    PromotionPerformance,
    PromotionRule,
} from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import { now, toTimestamp } from '../utils/firestore';
import { computePromotionDiscount, isPromotionMonotonic } from '../utils/promotions';
import * as promotionsRepo from '../repositories/promotions.repository';
import * as productsRepo from '../repositories/products.repository';
import { AuditActor, diffFields, recordAudit } from './audit.service';
import { listExpiringLots } from './inventory-alerts.service';
import { computePromotionPerformance } from './promotion-performance.service';

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
        const problem = ruleProblemFor(rule, product);
        if (problem) {
            throw badRequest(problem);
        }
    });
};

/**
 * Por qué la regla no tiene sentido al precio actual del producto, o `null`.
 * Es la misma validación del alta, reusada cuando cambia el precio.
 */
const ruleProblemFor = (rule: PromotionRule, product: Product): string | null => {
    if (rule.type === 'tiered') {
        for (const tier of rule.tiers) {
            if (tier.price >= tier.quantity * product.salePrice) {
                return `${tier.quantity} piezas por $${tier.price} no es menor al precio ` +
                    `normal de ${product.name} ($${product.salePrice} c/u)`;
            }
        }
    }
    const maxQty = rule.type === 'tiered'
        ? Math.max(...rule.tiers.map((tier) => tier.quantity))
        : rule.type === 'nxm' ? rule.buy : rule.minQty;
    if (computePromotionDiscount(rule, product.salePrice, maxQty) <= 0) {
        return `La promoción no da descuento sobre ${product.name}`;
    }
    if (!isPromotionMonotonic(rule, product.salePrice)) {
        return `Con esta promoción, llevar más piezas de ${product.name} costaría menos ` +
            'que llevar menos; ajusta el precio o la cantidad';
    }
    return null;
};

/**
 * Aviso por correo de una baja por precio. Una promo que desaparece sola del
 * mostrador sorprende a quien la dio de alta, y la bitácora nadie la lee a
 * diario. **Best-effort**: se espera (una promesa suelta muere cuando la
 * function responde) pero cualquier falla —Resend caído, destinatarios sin
 * configurar— solo se registra; el precio ya se guardó.
 *
 * El sender se importa dinámicamente: arrastra Resend y React Email, y este
 * módulo se carga en el arranque de la function `api`.
 */
const notifyRetiredByPrice = async (
    product: Product,
    retired: Array<{ promotion: Promotion; problem: string }>,
): Promise<void> => {
    try {
        const { sendPromotionsRetiredByPriceEmail } = await import(
            './promotion-alerts-sender.service'
        );
        await sendPromotionsRetiredByPriceEmail(product, retired);
    } catch (error) {
        console.error('No se pudo avisar por correo la baja de promociones por precio', {
            productId: product.id,
            promotionIds: retired.map((entry) => entry.promotion.id),
            error,
        });
    }
};

/**
 * Tras un cambio de precio, da de baja las promociones activas de ese producto
 * que el precio nuevo vuelve absurdas: "2 por $60" con la pieza a $61 cobra
 * más por una que por dos, y una pieza de ese paquete ya no se puede devolver.
 *
 * Se da de baja y no se bloquea el cambio de precio porque el POS también
 * edita precios sin red y los sube después: rechazar ese push atoraría su
 * cola. La regla es inmutable, así que la baja es de toda la promoción (aunque
 * tenga otros productos); reactivarla vuelve a validarla contra el catálogo.
 *
 * No lanza: el precio ya se guardó y una falla aquí no debe revertirlo ante
 * quien lo cambió. Devuelve las promociones dadas de baja.
 */
export const retirePromotionsBrokenByPrice = async (
    product: Product,
    actor?: AuditActor,
): Promise<Promotion[]> => {
    try {
        const promotions = await promotionsRepo.listActivePromotionsForProduct(product.id);
        const retired: Promotion[] = [];
        const problems: string[] = [];
        for (const promotion of promotions) {
            const problem = ruleProblemFor(promotion.rule, product);
            if (!problem) {
                continue;
            }
            const { after } = await promotionsRepo.updatePromotion(promotion.id, {
                isActive: false,
                updatedBy: actor?.userId ?? 'system',
            });
            await recordAudit({
                action: 'promotion.deactivated',
                entity: 'promotion',
                entityId: promotion.id,
                summary: `Promoción "${promotion.name}" dada de baja al cambiar el precio de ` +
                    `${product.name} a $${product.salePrice}`,
                userId: actor?.userId ?? 'system',
                roleSlug: actor?.roleSlug ?? null,
                changes: { isActive: { before: true, after: false } },
                metadata: { reason: 'price_changed', productId: product.id, problem },
            });
            retired.push(after);
            problems.push(problem);
        }
        if (retired.length) {
            await notifyRetiredByPrice(product, retired.map((promotion, index) => ({
                promotion,
                problem: problems[index],
            })));
        }
        return retired;
    } catch (error) {
        console.error('No se pudieron revisar las promociones tras el cambio de precio', {
            productId: product.id,
            error,
        });
        return [];
    }
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
    options: { replaces?: Promotion } = {},
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
            `en ${promotion.productIds.length} producto(s)` +
            (options.replaces ? `, reemplaza a "${options.replaces.name}"` : ''),
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        metadata: {
            rule: promotion.rule,
            productIds: promotion.productIds,
            ...(options.replaces ? { replaces: options.replaces.id } : {}),
        },
    });
    return promotion;
};

/**
 * "Editar" la regla o los productos de una promoción: como son inmutables (una
 * venta offline cobrada con la regla vieja debe seguir validando), se crea la
 * nueva y se da de baja la anterior.
 *
 * El orden importa: **primero se crea**. Si la nueva no pasa la validación
 * (regla absurda al precio de hoy, producto inactivo) se lanza antes de tocar
 * la vieja, y el mostrador nunca se queda sin promoción por un error de
 * captura. Si la vieja ya estaba inactiva, no hay baja que hacer y se devuelve
 * tal cual, pero la liga queda igual en la bitácora de las dos.
 */
export const replacePromotion = async (
    id: string,
    input: Parameters<typeof createPromotion>[0],
    actor: AuditActor,
): Promise<{ created: Promotion; retired: Promotion }> => {
    const existing = await getPromotion(id);
    const created = await createPromotion(input, actor, { replaces: existing });

    if (!existing.isActive) {
        await recordAudit({
            action: 'promotion.updated',
            entity: 'promotion',
            entityId: existing.id,
            summary: `Promoción "${existing.name}" reemplazada por "${created.name}"`,
            userId: actor.userId,
            roleSlug: actor.roleSlug,
            metadata: { reason: 'replaced', replacedBy: created.id },
        });
        return { created, retired: existing };
    }

    let after: Promotion;
    try {
        ({ after } = await promotionsRepo.updatePromotion(existing.id, {
            isActive: false,
            updatedBy: actor.userId,
        }));
    } catch (error) {
        // La nueva ya existe: si la vieja no se pudo dar de baja quedarían las
        // dos activas sobre los mismos productos y la caja aplicaría la de mayor
        // descuento, que casi siempre es la que se quería retirar. Se compensa
        // dando de baja la recién creada y se propaga el error original.
        await promotionsRepo.updatePromotion(created.id, {
            isActive: false,
            updatedBy: actor.userId,
        }).catch((rollbackError) => {
            console.error('No se pudo revertir el reemplazo de promoción', {
                replaced: existing.id,
                created: created.id,
                rollbackError,
            });
        });
        throw error;
    }
    await recordAudit({
        action: 'promotion.deactivated',
        entity: 'promotion',
        entityId: existing.id,
        summary: `Promoción "${existing.name}" dada de baja, reemplazada por "${created.name}"`,
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        changes: { isActive: { before: true, after: false } },
        metadata: { reason: 'replaced', replacedBy: created.id },
    });
    return { created, retired: after };
};

export const getPromotionPerformance = async (id: string): Promise<PromotionPerformance> =>
    computePromotionPerformance(await getPromotion(id));

/**
 * Descuento sugerido según lo que le falta al lote para caducar: más cerca,
 * más agresivo. Un 10 % a tres meses todavía deja margen; a un mes lo que se
 * pierde es el lote entero si no sale.
 */
export const suggestedPercentForExpiry = (daysToExpiry: number): number => {
    if (daysToExpiry <= 30) {
        return 30;
    }
    if (daysToExpiry <= 60) {
        return 20;
    }
    return 10;
};

/**
 * Lotes por caducar que conviene mover con una promoción de porcentaje desde
 * una pieza. Reusa la lectura de las alertas de inventario (vencidos, sin
 * existencia y productos inactivos ya quedan fuera).
 *
 * `hasActivePromotion` cuenta promos activas que no han terminado, **incluidas
 * las programadas** para después: si alguien ya agendó una, la sugerencia no
 * debe invitar a crear otra encima (no se acumulan; ganaría la mayor).
 */
export const listExpiringPromotionSuggestions = async (filters: {
    days: number;
}): Promise<ExpiringPromotionSuggestion[]> => {
    const [lots, activePromotions] = await Promise.all([
        listExpiringLots(filters.days),
        promotionsRepo.listPromotions({ activeOnly: true }),
    ]);
    const nowMs = now().toMillis();
    const promotedProducts = new Set(activePromotions
        .filter((promotion) => !promotion.endsAt || promotion.endsAt.toMillis() > nowMs)
        .flatMap((promotion) => promotion.productIds));

    return lots
        .map(({ batch, product, daysToExpiry }) => ({
            productId: product.id,
            productName: product.name,
            categoryId: product.categoryId,
            salePrice: product.salePrice,
            lotNumber: batch.lotNumber,
            expiryDate: batch.expiryDate.toDate().toISOString(),
            daysToExpiry,
            quantity: batch.quantity,
            hasActivePromotion: promotedProducts.has(product.id),
            suggestedRule: {
                type: 'percent' as const,
                percent: suggestedPercentForExpiry(daysToExpiry),
                minQty: 1 as const,
            },
        }))
        .sort((a, b) => a.daysToExpiry - b.daysToExpiry ||
            a.productName.localeCompare(b.productName));
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
