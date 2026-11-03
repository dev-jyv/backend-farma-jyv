import { Timestamp } from 'firebase-admin/firestore';
import { Coupon, CouponDiscount, CouponDto, CouponScope } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import { now, toTimestamp } from '../utils/firestore';
import { CouponEngineCoupon } from '../utils/coupons';
import { toCents } from '../utils/taxes';
import * as couponsRepo from '../repositories/coupons.repository';
import * as productsRepo from '../repositories/products.repository';
import { AuditActor, recordAudit } from './audit.service';

/**
 * Cupones de descuento (SPEC 47). Lectura hasta el mostrador (el POS los baja
 * con `/coupons/sync`), escritura de gerencia y administración, con el área
 * `promotions`: un cupón decide precio igual que una promoción.
 */

const isoOrNull = (value: Timestamp | null | undefined): string | null =>
    value ? value.toDate().toISOString() : null;

/** Contrato con panel y POS: mismas llaves que el documento, fechas en ISO. */
export const toCouponDto = (coupon: Coupon): CouponDto => ({
    id: coupon.id,
    code: coupon.code,
    name: coupon.name,
    scope: coupon.scope,
    productIds: coupon.productIds ?? [],
    discount: coupon.discount,
    minPurchase: coupon.minPurchase ?? null,
    startsAt: coupon.startsAt.toDate().toISOString(),
    endsAt: isoOrNull(coupon.endsAt),
    maxUses: coupon.maxUses ?? null,
    usedCount: coupon.usedCount ?? 0,
    isActive: coupon.isActive,
    deactivatedAt: isoOrNull(coupon.deactivatedAt),
    createdBy: coupon.createdBy,
    updatedBy: coupon.updatedBy,
    createdAt: coupon.createdAt.toDate().toISOString(),
    updatedAt: coupon.updatedAt.toDate().toISOString(),
});

/** El cupón en la forma del motor puro (centavos). */
export const toEngineCoupon = (coupon: Pick<
    Coupon,
    'scope' | 'productIds' | 'discount' | 'minPurchase'
>): CouponEngineCoupon => ({
    scope: coupon.scope,
    productIds: coupon.productIds ?? [],
    discount: coupon.discount.type === 'percent'
        ? { type: 'percent', percent: coupon.discount.percent }
        : { type: 'amount', amountCents: toCents(coupon.discount.amount) },
    minPurchaseCents: coupon.minPurchase === null || coupon.minPurchase === undefined
        ? null
        : toCents(coupon.minPurchase),
});

export const describeCouponDiscount = (discount: CouponDiscount, scope: CouponScope): string =>
    discount.type === 'percent'
        ? `${discount.percent}%`
        : `$${discount.amount.toFixed(2)}${scope === 'product' ? ' por pieza' : ''}`;

export const listCoupons = async (filters: {
    isActive?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: CouponDto[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await couponsRepo.listCouponsPage({
        isActive: filters.isActive,
        page,
        limit,
    });
    return { items: items.map(toCouponDto), meta: buildListMeta(page, limit, total) };
};

/**
 * Pull del POS. `serverTime` se toma **antes** de leer y es el cursor que la
 * caja reenvía como `updatedSince`: un cambio durante la lectura vuelve a
 * llegar en el siguiente pull en vez de perderse.
 */
export const listCouponsForSync = async (filters: {
    updatedSince?: string;
}): Promise<{ items: CouponDto[]; serverTime: string }> => {
    const serverTime = now().toDate().toISOString();
    const coupons = await couponsRepo.listCouponsForSync(filters.updatedSince);
    return { items: coupons.map(toCouponDto), serverTime };
};

export const getCoupon = async (code: string): Promise<CouponDto> => {
    const coupon = await couponsRepo.getCouponByCode(code);
    if (!coupon) {
        throw notFound('Cupón');
    }
    return toCouponDto(coupon);
};

/** Los productos de un cupón de producto deben existir y estar activos. */
const assertProductsExist = async (productIds: string[]): Promise<void> => {
    const products = await productsRepo.getProductsByIds(productIds);
    for (const id of productIds) {
        const product = products.get(id);
        if (!product) {
            throw badRequest(`El producto ${id} no existe`);
        }
        if (!product.isActive) {
            throw badRequest(`El producto ${product.name} está inactivo`);
        }
    }
};

export const createCoupon = async (
    input: {
        code: string;
        name: string;
        scope: CouponScope;
        productIds?: string[];
        discount: CouponDiscount;
        minPurchase?: number | null;
        startsAt?: string;
        endsAt?: string | null;
        maxUses?: number | null;
    },
    actor: AuditActor,
): Promise<CouponDto> => {
    const productIds = input.scope === 'product' ? input.productIds ?? [] : [];
    if (input.scope === 'product') {
        await assertProductsExist(productIds);
    }

    const coupon = await couponsRepo.createCoupon({
        code: input.code,
        name: input.name.trim(),
        scope: input.scope,
        productIds,
        discount: input.discount,
        minPurchase: input.scope === 'sale' ? input.minPurchase ?? null : null,
        startsAt: input.startsAt ? toTimestamp(input.startsAt) : now(),
        endsAt: input.endsAt ? toTimestamp(input.endsAt) : null,
        maxUses: input.maxUses ?? null,
        usedCount: 0,
        isActive: true,
        deactivatedAt: null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
    });

    await recordAudit({
        action: 'coupon.created',
        entity: 'coupon',
        entityId: coupon.id,
        summary: `Cupón ${coupon.code} "${coupon.name}" de ` +
            `${describeCouponDiscount(coupon.discount, coupon.scope)} en ` +
            (coupon.scope === 'product'
                ? `${coupon.productIds.length} producto(s)`
                : 'la venta'),
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        metadata: {
            scope: coupon.scope,
            discount: coupon.discount,
            productIds: coupon.productIds,
            minPurchase: coupon.minPurchase,
            maxUses: coupon.maxUses,
        },
    });
    return toCouponDto(coupon);
};

/**
 * Baja: el cupón deja de aplicarse en línea y fija `deactivatedAt`, que es el
 * fin de vigencia con que se miden las ventas offline. Dar de baja uno ya dado
 * de baja no hace nada (ni bitácora). Los usos no se devuelven nunca.
 */
export const deactivateCoupon = async (code: string, actor: AuditActor): Promise<CouponDto> => {
    const { coupon, changed } = await couponsRepo.deactivateCoupon(code, actor.userId);
    if (changed) {
        await recordAudit({
            action: 'coupon.deactivated',
            entity: 'coupon',
            entityId: coupon.id,
            summary: `Cupón ${coupon.code} "${coupon.name}" dado de baja con ` +
                `${coupon.usedCount} uso(s)`,
            userId: actor.userId,
            roleSlug: actor.roleSlug,
            changes: { isActive: { before: true, after: false } },
        });
    }
    return toCouponDto(coupon);
};
