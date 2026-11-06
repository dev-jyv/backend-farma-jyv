import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import {
    Batch,
    ControlledGroup,
    Coupon,
    PaymentMethod,
    PointPaymentSnapshot,
    Product,
    Promotion,
    Sale,
    SaleBilling,
    SaleCoupon,
    SaleCouponReview,
    SaleItemPromotion,
    SaleLineItem,
    SalePrescription,
    SaleReviewKind,
    SaleStockReviewItem,
    SALE_REVIEW_FILTERS,
    isSaleProductItem,
    saleBusinessAt,
    isSaleServiceItem,
    saleItemName,
} from '../types';
import {
    badRequest,
    conflict,
    forbidden,
    notFound,
    withDefaultSyncCode,
} from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { allocateFefoAvailable, BatchAllocation } from '../utils/fefo';
import { APP_TIME_ZONE, getZonedYmd } from '../utils/timezone';
import {
    breakdownLineTaxes,
    fromCents,
    prorateDiscount,
    sumTaxSummary,
    toCents,
} from '../utils/taxes';
import { db, now } from '../utils/firestore';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as pharmacyServicesRepo from '../repositories/pharmacy-services.repository';
import * as serviceProvidersRepo from '../repositories/service-providers.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as dailyStatsRepo from '../repositories/daily-stats.repository';
import * as cashSessionsRepo from '../repositories/cash-sessions.repository';
import * as customersRepo from '../repositories/customers.repository';
import * as promotionsRepo from '../repositories/promotions.repository';
import * as couponsRepo from '../repositories/coupons.repository';
import { computeCouponDiscount, CouponEngineLine } from '../utils/coupons';
import { toEngineCoupon } from './coupons.service';
import {
    computePromotionDiscount,
    isPromotionOpenAt,
    PROMOTION_SYNC_GRACE_MS,
} from '../utils/promotions';
import * as mercadoPagoService from './mercado-pago.service';
import {
    assertPrescriptionRules,
    resolveControlledRequirements,
    writeLedgerEntryInTransaction,
} from './controlled.service';
import { getControlledRule } from '../constants/controlled';
import { recordAudit } from './audit.service';
import { assertCanAccessSession } from './cash-sessions.service';
import { hasPermission } from '../constants/permissions';
import { RolePermission } from '../types';

interface SaleProductItemInput {
    /** Ausente en los payloads del POS anterior a los servicios: se lee como mercancía. */
    kind?: 'product';
    productId: string;
    quantity: number;
    discountAmount?: number;
    /** Precio cobrado; ausente en clientes anteriores (manda el catálogo). */
    unitPrice?: number;
    /**
     * Promoción que el POS aplicó a la partida. Solo el id: el monto lo recalcula
     * el servidor con la regla guardada, nunca se toma del cliente.
     */
    promotionId?: string;
    /** Con `'box'`, `quantity` son cajas y `unitPrice` el precio por caja (SPEC 46). */
    saleUnit?: 'box';
}

interface SaleServiceItemInput {
    kind: 'service';
    serviceId: string;
    quantity: number;
    discountAmount?: number;
    /** Precio cobrado; ausente en clientes anteriores (manda el catálogo). */
    unitPrice?: number;
    /** Doctor del catálogo `serviceProviders`, **no** un uid del sistema. */
    providerId?: string | null;
}

export type SaleItemInput = SaleProductItemInput | SaleServiceItemInput;

const SALES_COUNTER_ID = 'sales';
const MAX_SALE_LINE_ITEMS = 100;
const MAX_NON_ADMIN_DISCOUNT_RATE = 0.2;
const IDEMPOTENCY_COLLECTION = 'saleIdempotencyKeys';
/**
 * Cuánto puede ir adelantado el reloj de la caja respecto al servidor antes de
 * dejar de creer su `soldAt`. Más allá, se usa la hora del servidor.
 */
const SOLD_AT_MAX_CLOCK_AHEAD_MS = 10 * 60 * 1000;
/**
 * Antigüedad máxima de un `soldAt` creíble (SPEC 51). Más viejo que esto, la venta
 * queda con la fecha de recepción: los reportes por fecha de negocio consultan
 * `createdAt` con este mismo margen (`BUSINESS_DATE_LATE_MARGIN_MS`).
 */
const SOLD_AT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Por qué un `soldAt` offline no se usó como fecha de negocio. */
type SoldAtUntrustedReason = 'clock_ahead' | 'before_session' | 'too_old';
/** Ventana de reintento cubierta por la llave; después de esto el TTL de Firestore la borra. */
const IDEMPOTENCY_TTL_HOURS = 48;

const buildFolio = (sequence: number): string => `V-${String(sequence).padStart(6, '0')}`;

/**
 * La llave se guarda por cajero para que la llave de un cajero no pueda devolver
 * la venta de otro (los uuid los genera el cliente y no son de confianza).
 */
const buildIdempotencyDocId = (cashierId: string, key: string): string =>
    `${cashierId}:${key}`;

/**
 * Huella del cobro. Si llega la misma llave con un cobro distinto es un bug del
 * cliente (llave reciclada), no un retry: mejor fallar que devolver otra venta.
 */
/** Lo que la huella lee de cada partida: `SaleLineItem` resuelto o su réplica. */
interface FingerprintLine {
    kind?: 'product' | 'service';
    productId?: string;
    serviceId?: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    promotion?: { promotionId: string } | null;
    saleUnit?: { type: 'box'; boxes: number; piecesPerBox: number; boxPrice: number };
}

const buildRequestFingerprint = (input: {
    items: FingerprintLine[];
    total: number;
    paymentMethod: PaymentMethod;
    cashSessionId: string;
    couponCode?: string;
}): string => createHash('sha256')
    .update(JSON.stringify({
        // La partida de mercancía conserva **exactamente** la forma de siempre:
        // cambiarla invalidaría las llaves vivas (48 h de TTL) y un retry legítimo
        // de una venta ya registrada respondería "llave usada para otra venta".
        items: input.items.map((item) => (item.kind === 'service'
            ? {
                kind: 'service',
                serviceId: item.serviceId,
                quantity: item.quantity,
                unitPrice: toCents(item.unitPrice),
                discountAmount: toCents(item.discountAmount),
            }
            : {
                productId: item.productId,
                quantity: item.quantity,
                unitPrice: toCents(item.unitPrice),
                discountAmount: toCents(item.discountAmount),
                // Solo cuando viene: sin promo la huella queda idéntica a la de
                // siempre y las llaves vivas siguen validando.
                ...(item.promotion ? { promotionId: item.promotion.promotionId } : {}),
                // Mismo criterio para la venta por caja: 1 caja de 10 y 10 piezas
                // sueltas bajan lo mismo, pero no son el mismo cobro.
                ...(item.saleUnit
                    ? {
                        saleUnit: {
                            type: item.saleUnit.type,
                            boxes: item.saleUnit.boxes,
                            piecesPerBox: item.saleUnit.piecesPerBox,
                            boxPrice: toCents(item.saleUnit.boxPrice),
                        },
                    }
                    : {}),
            })),
        total: toCents(input.total),
        paymentMethod: input.paymentMethod,
        cashSessionId: input.cashSessionId,
        // Solo con cupón: sin él la huella es la de siempre. Cambiar el cupón con
        // la misma llave es otro cobro, no un reintento.
        ...(input.couponCode ? { couponCode: input.couponCode } : {}),
    }))
    .digest('hex');

/**
 * Huella del **payload normalizado** (SPEC 48): no depende del catálogo, del stock
 * ni del rol, así que se calcula antes de leer nada y un reintento con la misma
 * llave se reconoce aunque el producto se haya desactivado, el lote haya caducado
 * o el precio haya cambiado desde el primer intento.
 *
 * Se guarda junto a `requestFingerprint` (la huella resuelta de siempre) y manda
 * cuando existe. Las llaves anteriores a este campo (TTL de 48 h) solo traen la
 * resuelta y se comparan con ella: ver `buildLegacyRequestFingerprint`.
 */
const buildPayloadFingerprint = (input: {
    items: SaleItemInput[];
    saleDiscountAmount?: number;
    paymentMethod: PaymentMethod;
    cashSessionId: string;
    couponCode?: string;
}): string => {
    const cents = (value: number | undefined): number | null =>
        (value === undefined || value === null ? null : toCents(value));
    return createHash('sha256')
        .update(JSON.stringify({
            v: 2,
            items: input.items.map((item) => (item.kind === 'service'
                ? {
                    kind: 'service',
                    serviceId: item.serviceId,
                    quantity: item.quantity,
                    unitPrice: cents(item.unitPrice),
                    discountAmount: toCents(item.discountAmount ?? 0),
                }
                : {
                    productId: item.productId,
                    quantity: item.quantity,
                    unitPrice: cents(item.unitPrice),
                    discountAmount: toCents(item.discountAmount ?? 0),
                    ...(item.promotionId ? { promotionId: item.promotionId } : {}),
                    ...(item.saleUnit ? { saleUnit: item.saleUnit } : {}),
                })),
            saleDiscountAmount: toCents(input.saleDiscountAmount ?? 0),
            paymentMethod: input.paymentMethod,
            cashSessionId: input.cashSessionId,
            ...(input.couponCode ? { couponCode: input.couponCode } : {}),
        }))
        .digest('hex');
};

/**
 * Huella resuelta (`buildRequestFingerprint`) de un payload, para comparar con
 * una llave guardada antes de `payloadFingerprint`. Resuelve **solo precios**
 * (producto, caja, servicio y la regla de la promoción), nunca lotes, y replica
 * paso a paso las cuentas de `applySale` (mismos redondeos, mismo orden) para
 * dar el mismo hash.
 *
 * Devuelve `null` si no puede resolverla (un producto o servicio que ya no
 * existe): entonces decide la ruta de siempre, que vuelve a comparar con la
 * huella calculada sobre la venta resuelta.
 */
const buildLegacyRequestFingerprint = async (input: {
    items: SaleItemInput[];
    saleDiscountAmount?: number;
    paymentMethod: PaymentMethod;
    cashSessionId: string;
    couponCode?: string;
}): Promise<string | null> => {
    const productIds = input.items.flatMap((item) => (item.kind !== 'service'
        ? [item.productId]
        : []));
    const serviceIds = [...new Set(input.items.flatMap((item) => (item.kind === 'service'
        ? [item.serviceId]
        : [])))];
    const [products, promotions, services] = await Promise.all([
        productsRepo.getProductsByIds(productIds),
        promotionsRepo.getPromotionsByIds(input.items.flatMap((item) =>
            (item.kind !== 'service' && item.promotionId ? [item.promotionId] : []))),
        Promise.all(serviceIds.map((id) => pharmacyServicesRepo.getPharmacyServiceById(id))),
    ]);
    const serviceById = new Map(serviceIds.map((id, index) => [id, services[index]]));

    const lines: FingerprintLine[] = [];
    let subtotal = 0;
    let lineDiscountTotal = 0;
    for (const item of input.items) {
        if (item.kind === 'service') {
            const service = serviceById.get(item.serviceId);
            if (!service) {
                return null;
            }
            const unitPrice = item.unitPrice ?? service.price;
            const itemSubtotal = fromCents(toCents(unitPrice * item.quantity));
            const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
            subtotal += itemSubtotal;
            lineDiscountTotal += discountAmount;
            lines.push({
                kind: 'service',
                serviceId: item.serviceId,
                quantity: item.quantity,
                unitPrice,
                discountAmount,
            });
            continue;
        }
        const product = products.get(item.productId);
        const isBox = item.saleUnit === 'box';
        if (!product || (isBox && !(product.boxQuantity && product.boxPrice))) {
            return null;
        }
        const piecesPerBox = isBox ? product.boxQuantity as number : 1;
        const catalogPrice = isBox ? product.boxPrice as number : product.salePrice;
        const chargedPrice = item.unitPrice ?? catalogPrice;
        const unitPrice = isBox ? chargedPrice / piecesPerBox : chargedPrice;
        const itemSubtotal = fromCents(toCents(chargedPrice * item.quantity));
        const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
        subtotal += itemSubtotal;
        lineDiscountTotal += discountAmount;

        let promotion: { promotionId: string } | null = null;
        if (item.promotionId) {
            const rule = promotions.get(item.promotionId);
            if (!rule || !rule.productIds.includes(product.id)) {
                return null;
            }
            const promoDiscount = Math.min(
                computePromotionDiscount(rule.rule, unitPrice, item.quantity),
                discountAmount,
            );
            promotion = promoDiscount > 0 ? { promotionId: rule.id } : null;
        }
        lines.push({
            kind: 'product',
            productId: product.id,
            quantity: item.quantity * piecesPerBox,
            unitPrice,
            discountAmount,
            promotion,
            ...(isBox
                ? {
                    saleUnit: {
                        type: 'box' as const,
                        boxes: item.quantity,
                        piecesPerBox,
                        boxPrice: chargedPrice,
                    },
                }
                : {}),
        });
    }
    const saleDiscountAmount = Math.min(
        Math.max(0, input.saleDiscountAmount ?? 0),
        subtotal - lineDiscountTotal,
    );
    const discountTotal = fromCents(toCents(lineDiscountTotal) + toCents(saleDiscountAmount));
    return buildRequestFingerprint({
        items: lines,
        total: fromCents(toCents(subtotal) - toCents(discountTotal)),
        paymentMethod: input.paymentMethod,
        cashSessionId: input.cashSessionId,
        couponCode: input.couponCode,
    });
};

/** Las dos huellas de un intento; `resolved` es `null` mientras no se calcula. */
interface SaleFingerprints {
    payload: string;
    resolved: string | null;
}

/**
 * Manda `payloadFingerprint` cuando la llave lo trae (escrita desde SPEC 48); si
 * no, la llave es anterior y se compara la huella resuelta de siempre.
 */
const matchesStoredFingerprint = (
    stored: FirebaseFirestore.DocumentData,
    fingerprints: SaleFingerprints,
): boolean => (typeof stored.payloadFingerprint === 'string'
    ? stored.payloadFingerprint === fingerprints.payload
    : stored.requestFingerprint === fingerprints.resolved);

const mapSaleDoc = (doc: FirebaseFirestore.DocumentSnapshot): Sale => {
    const data = doc.data()!;
    return {
        id: doc.id,
        ...data,
        pointPayment: data.pointPayment ?? null,
        cardPaymentReference: data.cardPaymentReference ?? null,
    } as Sale;
};

/**
 * Resuelve una llave ya registrada: devuelve la venta original (retry legítimo) o
 * lanza si la huella del cobro no coincide.
 */
const resolveReplayedSale = (
    idemDoc: FirebaseFirestore.DocumentSnapshot,
    saleDoc: FirebaseFirestore.DocumentSnapshot,
    fingerprints: SaleFingerprints,
): Sale => {
    if (!matchesStoredFingerprint(idemDoc.data()!, fingerprints)) {
        throw conflict(
            'Esta llave de idempotencia ya se usó para una venta distinta',
            'IDEMPOTENCY_CONFLICT',
        );
    }
    if (!saleDoc.exists) {
        throw conflict(
            'La llave de idempotencia apunta a una venta que ya no existe',
            'IDEMPOTENCY_CONFLICT',
        );
    }
    return mapSaleDoc(saleDoc);
};

interface TenderInput {
    paymentMethod: PaymentMethod;
    total: number;
    amountReceived?: number;
    cardPaymentReference?: string;
    /**
     * Monto cobrado con tarjeta (order Point). Obligatorio en `mixed`: es lo que
     * define cuánto falta cubrir en efectivo.
     */
    cardAmount?: number;
}

interface TenderResult {
    amountReceived: number | null;
    change: number | null;
    cashAmount: number | null;
    cardAmount: number | null;
    cardPaymentReference: string | null;
}

/**
 * Reparte el cobro entre efectivo y tarjeta.
 *
 *  - `cash`      — el efectivo recibido cubre el total; cambio = recibido − total.
 *  - `card`/`transfer` — sin efectivo.
 *  - `mixed`     — la tarjeta paga `cardAmount` y el efectivo cubre el resto
 *                  (`total − cardAmount`). El cambio se calcula contra **esa
 *                  parte en efectivo**, no contra el total: exigir que el efectivo
 *                  cubra el total completo era el bug histórico de `mixed`.
 */
const resolveTender = (input: TenderInput): TenderResult => {
    const { paymentMethod, total, amountReceived, cardPaymentReference } = input;

    if (paymentMethod === 'card' || paymentMethod === 'transfer') {
        // Sin `cardPaymentReference` la venta queda como **registro** del cobro con
        // tarjeta, igual que el efectivo: nadie prueba que el dinero entró, lo
        // afirma el cajero. Cuando hay terminal Point emparejada, la order sí lo
        // prueba y se sigue exigiendo (ver `resolvePointPayment`).
        return {
            amountReceived: null,
            change: null,
            cashAmount: null,
            cardAmount: paymentMethod === 'card' ? total : null,
            cardPaymentReference: cardPaymentReference ?? null,
        };
    }

    if (amountReceived === undefined) {
        throw badRequest('El monto recibido es requerido para este método de pago');
    }

    if (paymentMethod === 'cash') {
        if (toCents(amountReceived) < toCents(total)) {
            throw badRequest('El monto recibido es menor al total de la venta');
        }
        return {
            amountReceived,
            change: fromCents(toCents(amountReceived) - toCents(total)),
            cashAmount: total,
            cardAmount: null,
            cardPaymentReference: null,
        };
    }

    // mixed
    // Lo que el mixto necesita es el **reparto**, no la order: con terminal viene
    // del monto de la order; sin terminal lo captura el cajero.
    if (input.cardAmount === undefined) {
        throw badRequest('El pago mixto requiere el monto cobrado con tarjeta');
    }

    const cardCents = toCents(input.cardAmount);
    const totalCents = toCents(total);
    if (cardCents <= 0) {
        throw badRequest('El monto cobrado con tarjeta debe ser mayor a cero');
    }
    if (cardCents >= totalCents) {
        throw badRequest(
            'La tarjeta cubre el total: registra la venta como pago con tarjeta',
        );
    }

    const cashCents = totalCents - cardCents;
    if (toCents(amountReceived) < cashCents) {
        throw badRequest(
            `El efectivo recibido no cubre la parte en efectivo (${fromCents(cashCents)})`,
        );
    }

    return {
        amountReceived,
        change: fromCents(toCents(amountReceived) - cashCents),
        cashAmount: fromCents(cashCents),
        cardAmount: fromCents(cardCents),
        // Sin terminal Point no hay referencia que guardar: el mixto queda como
        // registro del reparto, igual que la parte en efectivo.
        cardPaymentReference: cardPaymentReference ?? null,
    };
};

const resolvePointPayment = async (input: {
    paymentMethod: PaymentMethod;
    orderId: string | null;
    saleTotal: number;
}): Promise<PointPaymentSnapshot | null> => {
    if (input.paymentMethod !== 'card' && input.paymentMethod !== 'mixed') {
        return null;
    }
    if (!input.orderId) {
        // Cobro con tarjeta registrado a mano (sin terminal emparejada): no hay
        // order que validar. El tender resuelve el reparto con lo que mandó el POS.
        return null;
    }

    const existing = await salesRepo.findSaleByPointOrderId(input.orderId);
    if (existing && !existing.voidedAt) {
        throw conflict('Esta order de Mercado Pago ya está asociada a una venta');
    }

    const order = await mercadoPagoService.getOrder(input.orderId);
    if (order.status !== 'processed') {
        throw badRequest(
            `La order de Mercado Pago no está pagada (estado: ${order.status})`,
        );
    }

    const paidCents = toCents(Number(order.amount));
    const totalCents = toCents(input.saleTotal);
    if (!Number.isFinite(paidCents) || paidCents <= 0) {
        throw badRequest('El monto de la order de Mercado Pago es inválido');
    }
    if (input.paymentMethod === 'card' && paidCents !== totalCents) {
        throw badRequest(
            'El monto de la order de Mercado Pago no coincide con el total de la venta',
        );
    }
    if (input.paymentMethod === 'mixed' && paidCents > totalCents) {
        throw badRequest(
            'El monto de la order de Mercado Pago supera el total de la venta',
        );
    }

    return {
        orderId: order.id,
        paymentId: order.paymentId,
        status: order.status,
        amount: order.amount,
        terminalId: order.terminalId,
        externalReference: order.externalReference,
    };
};

/**
 * Valida la promoción que el POS aplicó a una partida y devuelve la copia que se
 * guarda en la venta. El monto sale de la regla, no del cliente; si el POS
 * descontó menos de lo que la regla da, se toma lo que descontó (la parte manual
 * queda en cero, nunca negativa).
 *
 * Que la promo no aplique al producto es un 400 inmediato (no cambia nunca). Que
 * ya no esté vigente se devuelve como `closed` y el llamador lo lanza **después**
 * de la verificación de idempotencia: el reintento de una venta que ya se
 * registró debe devolver esa venta, no un "no está vigente" que empuje a cobrar
 * otra vez.
 */
const resolveLinePromotion = (input: {
    promotion: Promotion | undefined;
    promotionId: string;
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    discountAmount: number;
    atMs: number;
    graceMs: number;
}): { promotion: SaleItemPromotion | null; closed: boolean } => {
    const { promotion } = input;
    if (!promotion || !promotion.productIds.includes(input.productId)) {
        throw badRequest(`La promoción no aplica a ${input.productName}`);
    }
    // Inactiva sin `deactivatedAt` no debería existir, pero si existe se trata
    // como cerrada: sin fecha de baja no hay margen que conceder.
    const closed = (!promotion.isActive && !promotion.deactivatedAt) ||
        !isPromotionOpenAt(promotion, input.atMs, input.graceMs);
    const ruleDiscount = computePromotionDiscount(
        promotion.rule,
        input.unitPrice,
        input.quantity,
    );
    const discountAmount = Math.min(ruleDiscount, input.discountAmount);
    if (discountAmount <= 0) {
        return { promotion: null, closed };
    }
    return {
        promotion: {
            promotionId: promotion.id,
            name: promotion.name,
            rule: promotion.rule,
            discountAmount,
        },
        closed,
    };
};

interface ResolvedSaleCoupon {
    /** Documento leído antes de la transacción; `null` si el código no existe. */
    coupon: Coupon | null;
    /** Parte del cupón por índice de partida (alcance `product`), en pesos. */
    lineParts: Map<number, number>;
    /** Parte del cupón dentro de `saleDiscountAmount` (alcance `sale`), en pesos. */
    salePart: number;
    totalCents: number;
    /** Rechazo en línea; se lanza **después** de la revisión de idempotencia. */
    error: string | null;
    /** Marca offline decidida antes de la transacción (`over_limit` se decide dentro). */
    review: SaleCouponReview | null;
}

const isCouponExhausted = (coupon: Pick<Coupon, 'maxUses' | 'usedCount'>): boolean =>
    coupon.maxUses !== null && coupon.maxUses !== undefined &&
    (coupon.usedCount ?? 0) >= coupon.maxUses;

/** Cerrado = inactivo sin fecha de baja, o fuera de vigencia a `atMs` (regla de promociones). */
const isCouponClosed = (coupon: Coupon, atMs: number, graceMs: number): boolean =>
    (!coupon.isActive && !coupon.deactivatedAt) ||
    !isPromotionOpenAt(coupon, atMs, graceMs);

/**
 * Cupón de la venta (SPEC 47): montos calculados con el motor en centavos y
 * con **tope en lo que mandó la caja**, igual que las promociones.
 *
 * - `product`: la parte de cada partida elegible (sin promoción) sale del motor
 *   sobre `subtotal − promoción`; lo que la caja haya descontado de más en esa
 *   partida queda como descuento manual y sigue topado.
 * - `sale`: la parte del cupón es `min(motor, saleDiscountAmount)`; el resto
 *   de `saleDiscountAmount`, si lo hay, es manual.
 *
 * Los montos se calculan aunque el cupón esté vencido o agotado: el reintento
 * de una venta que ya se registró debe dar la misma huella y devolverla, no un
 * 400. Los rechazos en línea viajan en `error`; offline nunca se rechaza por
 * vigencia ni por usos, se marca para revisión.
 */
const resolveSaleCoupon = (input: {
    code: string;
    coupon: Coupon | null;
    items: SaleLineItem[];
    saleDiscountAmount: number;
    offline: boolean;
    atMs: number;
    graceMs: number;
}): ResolvedSaleCoupon => {
    const { code, coupon } = input;
    const empty = {
        coupon,
        lineParts: new Map<number, number>(),
        salePart: 0,
        totalCents: 0,
    };
    if (!coupon) {
        return input.offline
            ? { ...empty, error: null, review: { reason: 'not_found', code } }
            : { ...empty, error: `El cupón ${code} no existe`, review: null };
    }

    const engineCoupon = toEngineCoupon(coupon);
    const engineLines: CouponEngineLine[] = input.items.map((item) => {
        const subtotalCents = toCents(item.subtotal);
        if (isSaleServiceItem(item)) {
            // Un servicio nunca es elegible en alcance producto; en venta cuenta
            // en la base como cualquier partida (su neto ya trae su descuento).
            return {
                productId: `service:${item.serviceId}`,
                pieces: item.quantity,
                netCents: subtotalCents - toCents(item.discountAmount),
                hasPromotion: false,
            };
        }
        const promoCents = toCents(item.promotion?.discountAmount ?? 0);
        return {
            productId: item.productId,
            pieces: item.quantity,
            netCents: engineCoupon.scope === 'product'
                ? subtotalCents - promoCents
                : subtotalCents - toCents(item.discountAmount),
            hasPromotion: Boolean(item.promotion),
        };
    });
    const result = computeCouponDiscount(engineCoupon, engineLines);

    const lineParts = new Map<number, number>();
    let totalCents = 0;
    let salePart = 0;
    if (coupon.scope === 'product') {
        input.items.forEach((item, index) => {
            if (isSaleServiceItem(item) || result.lines[index] <= 0) {
                return;
            }
            const sentCents = toCents(item.discountAmount) -
                toCents(item.promotion?.discountAmount ?? 0);
            const partCents = Math.max(0, Math.min(result.lines[index], sentCents));
            if (partCents > 0) {
                lineParts.set(index, fromCents(partCents));
                totalCents += partCents;
            }
        });
    } else {
        const partCents = Math.max(
            0,
            Math.min(result.saleCents, toCents(input.saleDiscountAmount)),
        );
        salePart = fromCents(partCents);
        totalCents = partCents;
    }

    const closed = isCouponClosed(coupon, input.atMs, input.graceMs);
    const exhausted = isCouponExhausted(coupon);
    const resolved = { coupon, lineParts, salePart, totalCents };

    if (input.offline) {
        // Sin efecto (la caja y el servidor no coinciden): el cupón se ignora y
        // lo descontado queda como manual. No consume uso ni marca revisión.
        return {
            ...resolved,
            error: null,
            review: totalCents > 0 && closed ? { reason: 'out_of_window', code } : null,
        };
    }

    let error: string | null = null;
    if (closed) {
        error = `El cupón ${code} no está vigente`;
    } else if (exhausted) {
        error = `El cupón ${code} ya alcanzó su límite de usos`;
    } else if (result.totalCents <= 0) {
        if (coupon.scope === 'sale') {
            const baseCents = engineLines.reduce((sum, line) => sum + line.netCents, 0);
            error = engineCoupon.minPurchaseCents !== null &&
                baseCents < engineCoupon.minPurchaseCents
                ? `La compra mínima para usar el cupón ${code} es ` +
                    `$${fromCents(engineCoupon.minPurchaseCents).toFixed(2)}`
                : `El cupón ${code} no tiene efecto en esta venta`;
        } else {
            const eligible = input.items.filter((item) =>
                !isSaleServiceItem(item) && coupon.productIds.includes(item.productId));
            error = eligible.length && eligible.every((item) =>
                !isSaleServiceItem(item) && Boolean(item.promotion))
                ? `Los productos del cupón ${code} ya tienen promoción`
                : `El cupón ${code} no aplica a los productos de la venta`;
        }
    } else if (totalCents <= 0) {
        error = `El cupón ${code} no tiene efecto en esta venta`;
    }
    return { ...resolved, error, review: null };
};

/**
 * FEFO de una partida sobre `batches` (vigentes primero, los caducados no se
 * venden). Descuenta lo asignado **en la misma lista**, así la siguiente partida
 * del mismo producto ve solo lo que queda y la venta se reparte sobre el total de
 * piezas. Lo usan el plan previo y el reparto dentro de la transacción, con el
 * mismo mensaje y el mismo código en los dos.
 *
 * La caducidad se mide a `options.now`, la fecha de negocio de la venta (SPEC 51):
 * un lote que caducó a medianoche no impide registrar una venta offline de ayer.
 *
 * Con `allowShortfall` (venta offline ya cobrada, SPEC 52) nunca rechaza: asigna
 * lo vendible que haya y devuelve el resto en `shortfall`. Ningún lote baja de cero.
 */
const allocateSaleBatches = (
    batches: Batch[],
    pieces: number,
    productName: string,
    options: { now: Date; allowShortfall: boolean },
): { allocations: BatchAllocation[]; shortfall: number } => {
    const { allocations, shortfall, expiredQuantity } = allocateFefoAvailable(
        batches,
        pieces,
        { excludeExpired: true, now: options.now },
    );
    if (shortfall > 0 && !options.allowShortfall) {
        if (expiredQuantity > 0) {
            throw badRequest(
                `El stock disponible de ${productName} está vencido`,
                'BATCH_EXPIRED',
            );
        }
        throw badRequest(`Stock insuficiente para ${productName}`, 'STOCK_INSUFFICIENT');
    }
    for (const allocation of allocations) {
        const batch = batches.find((entry) => entry.id === allocation.batchId);
        if (batch) {
            batch.quantity -= allocation.quantity;
        }
    }
    return { allocations, shortfall };
};

/**
 * Registra una venta. Todo rechazo de negocio sale con un código de
 * sincronización (SPEC 49): los que la caja resuelve por un camino propio
 * (stock, catálogo, turno, llave) lo llevan desde donde se lanzan, y el resto es
 * una validación que la caja muestra (`VALIDATION`).
 */
export const createSale = async (input: CreateSaleInput): Promise<Sale> => {
    try {
        return await applySale(input);
    } catch (error) {
        throw withDefaultSyncCode(error, 'VALIDATION');
    }
};

type CreateSaleInput = Parameters<typeof applySale>[0];

const applySale = async (input: {
    idempotencyKey?: string;
    items: SaleItemInput[];
    saleDiscountAmount?: number;
    paymentMethod: PaymentMethod;
    amountReceived?: number;
    cardPaymentReference?: string;
    /** Reparto con tarjeta en mixto sin terminal Point (ver `resolveTender`). */
    cardAmount?: number;
    cashSessionId: string;
    cashierId: string;
    customerId?: string;
    customerName?: string;
    prescription?: SalePrescription;
    /** Confirmación de que la receta se retuvo (grupos I a III). */
    prescriptionRetained?: boolean;
    billing?: SaleBilling;
    roleSlug?: string;
    /**
     * Venta cobrada sin conexión que llega por `/sales/bulk`. Una promo fuera de
     * vigencia **no la rechaza**: el cliente ya pagó ese precio y rechazarla deja
     * dinero en el cajón sin venta registrada. Se acepta y queda marcada para
     * revisión (`promotionReview` + bitácora). Una venta en línea sí se rechaza:
     * el cajero tiene al cliente enfrente y puede corregir.
     */
    offline?: boolean;
    /** Hora local del cobro que reporta la caja; solo cuenta en `offline`. */
    soldAt?: string;
    /** Código de cupón ya normalizado (mayúsculas); uno por venta (SPEC 47). */
    couponCode?: string;
}): Promise<Sale> => {
    if (!input.items.length) {
        throw badRequest('La venta debe tener al menos un producto');
    }
    if (input.items.length > MAX_SALE_LINE_ITEMS) {
        throw badRequest(
            `La venta no puede tener más de ${MAX_SALE_LINE_ITEMS} productos`,
        );
    }

    const firestore = db();
    const saleRef = firestore.collection('sales').doc();
    const cashSessionRef = firestore.collection('cashSessions').doc(input.cashSessionId);
    const counterRef = firestore.collection('counters').doc(SALES_COUNTER_ID);
    const timestamp = now();
    const couponCode = input.couponCode?.trim().toUpperCase() || undefined;

    // Idempotencia **antes de todo** (SPEC 48): antes del catálogo, del stock, de
    // FEFO y del tope de descuento. Si una venta se confirmó y su respuesta se
    // perdió, el reintento ya no ve el stock descontado ni el producto
    // desactivado ni el rol cambiado: ve su venta. La huella es la del payload,
    // que no necesita leer nada.
    const payloadFingerprint = buildPayloadFingerprint({
        items: input.items,
        saleDiscountAmount: input.saleDiscountAmount,
        paymentMethod: input.paymentMethod,
        cashSessionId: input.cashSessionId,
        couponCode,
    });
    const idempotencyRef = input.idempotencyKey
        ? firestore
            .collection(IDEMPOTENCY_COLLECTION)
            .doc(buildIdempotencyDocId(input.cashierId, input.idempotencyKey))
        : null;
    if (idempotencyRef) {
        const idemDoc = await idempotencyRef.get();
        const stored = idemDoc.data();
        if (stored) {
            // Llave anterior a `payloadFingerprint`: se compara con la huella
            // resuelta, leyendo solo precios. Si no coincide o no se puede
            // resolver, sigue la ruta de siempre y la transacción decide.
            const resolved = typeof stored.payloadFingerprint === 'string'
                ? null
                : await buildLegacyRequestFingerprint({ ...input, couponCode });
            if (typeof stored.payloadFingerprint === 'string' ||
                (resolved !== null && resolved === stored.requestFingerprint)) {
                const existingSaleDoc = await firestore
                    .collection('sales')
                    .doc(stored.saleId as string)
                    .get();
                return resolveReplayedSale(idemDoc, existingSaleDoc, {
                    payload: payloadFingerprint,
                    resolved,
                });
            }
        }
    }

    const saleItems: SaleLineItem[] = [];
    let subtotal = 0;
    let lineDiscountTotal = 0;

    type CachedProduct = Awaited<ReturnType<typeof productsRepo.getProductById>>;
    type CachedBatches = Awaited<ReturnType<typeof batchesRepo.listBatchesByProduct>>;
    type CachedService = Awaited<
        ReturnType<typeof pharmacyServicesRepo.getPharmacyServiceById>
    >;

    const productCache = new Map<string, CachedProduct>();
    const batchCache = new Map<string, CachedBatches>();
    // Catálogo de servicios de la venta: el desglose fiscal y la comisión se
    // resuelven después de prorratear el descuento, así que hace falta volver a
    // consultarlo por partida sin pagar otra lectura.
    const serviceCache = new Map<string, CachedService>();

    // Todas las promociones de la venta en una sola lectura, fuera de la
    // transacción: la regla es inmutable, así que no hay carrera que cerrar.
    const promotions = await promotionsRepo.getPromotionsByIds(
        input.items.flatMap((item) => (item.kind !== 'service' && item.promotionId
            ? [item.promotionId]
            : [])),
    );

    // Hora del cobro que reporta la caja: solo cuenta offline (SPEC 51).
    const soldAtMs = input.offline && input.soldAt ? Date.parse(input.soldAt) : NaN;
    const hasSoldAt = Number.isFinite(soldAtMs);
    let closedPromotionName: string | null = null;
    const outOfWindowPromotions: string[] = [];
    /** Productos y servicios inactivos aceptados en una venta offline (SPEC 52). */
    const inactiveCatalogIds: string[] = [];

    // El cupón se lee una vez aquí (vigencia, productos, mínimo) y otra dentro
    // de la transacción (`usedCount`), que es la que decide el último uso.
    //
    // Lecturas previas en bloque y en paralelo: solo sirven para validar y para el
    // mensaje en línea. La transacción vuelve a leer lotes y productos y es la que
    // reparte (SPEC 50). Los lotes de cada producto se piden a la vez, no uno por
    // partida en serie: con 50 ventas por lote la serie rozaba los 60 s (SPEC 48).
    const cartProductIds = [...new Set(input.items.flatMap((item) => (item.kind !== 'service'
        ? [item.productId]
        : [])))];
    const [preloadedCoupon, preloadedProducts, preloadedBatches, preloadedSession] =
        await Promise.all([
            couponCode ? couponsRepo.getCouponByCode(couponCode) : Promise.resolve(null),
            productsRepo.getProductsByIds(
                input.items.flatMap((item) => (item.kind !== 'service' ? [item.productId] : [])),
            ),
            Promise.all(cartProductIds.map((productId) =>
                batchesRepo.listBatchesByProduct(productId, { onlyAvailable: true }))),
            // La apertura del turno decide si el `soldAt` es creíble; solo hace
            // falta con `soldAt` offline. `openedAt` no cambia: basta leerla aquí.
            hasSoldAt
                ? cashSessionsRepo.getCashSessionById(input.cashSessionId)
                : Promise.resolve(null),
        ]);
    cartProductIds.forEach((productId, index) => {
        batchCache.set(productId, preloadedBatches[index]);
    });

    // Fecha de negocio (SPEC 51). Offline vale la hora del cobro que reporta la
    // caja si es creíble: no más de 10 min en el futuro (reloj adelantado), no
    // anterior a la apertura del turno, no más vieja de 7 días. Si no, la de
    // recepción. En línea siempre es la de recepción.
    let soldAtUntrustedReason: SoldAtUntrustedReason | null = null;
    if (hasSoldAt) {
        const openedAtMs = preloadedSession?.openedAt?.toMillis();
        if (soldAtMs > timestamp.toMillis() + SOLD_AT_MAX_CLOCK_AHEAD_MS) {
            soldAtUntrustedReason = 'clock_ahead';
        } else if (openedAtMs !== undefined && soldAtMs < openedAtMs) {
            soldAtUntrustedReason = 'before_session';
        } else if (soldAtMs < timestamp.toMillis() - SOLD_AT_MAX_AGE_MS) {
            soldAtUntrustedReason = 'too_old';
        }
    }
    const trustedSoldAt = hasSoldAt && soldAtUntrustedReason === null;
    const businessAt = trustedSoldAt ? Timestamp.fromMillis(soldAtMs) : timestamp;
    /** FEFO excluye solo los lotes caducados a la hora del cobro (SPEC 51). */
    const fefoNow = businessAt.toDate();
    /** Offline, la venta ya cobrada entra aunque falte stock (SPEC 52). */
    const allowShortfall = Boolean(input.offline);

    // Offline, la vigencia de promociones y cupones se mide a la hora del cobro.
    // Sin `soldAt` creíble (POS anterior a este campo, reloj desfasado) se usa la
    // del servidor con el margen de siempre.
    const promotionAtMs = trustedSoldAt ? soldAtMs : timestamp.toMillis();
    const promotionGraceMs = input.offline && !trustedSoldAt ? PROMOTION_SYNC_GRACE_MS : 0;

    for (const item of input.items) {
        if (item.quantity <= 0) {
            throw badRequest('Cantidad inválida en un ítem de venta');
        }

        // Rama de servicio: no toca inventario, no entra al libro de controlados y
        // congela la comisión del doctor. Todo lo demás (descuentos, impuestos,
        // reparto del efectivo) sigue el mismo camino que la mercancía.
        if (item.kind === 'service') {
            let service = serviceCache.get(item.serviceId);
            if (!service) {
                service = await pharmacyServicesRepo.getPharmacyServiceById(item.serviceId);
                serviceCache.set(item.serviceId, service);
            }
            // Mismo mensaje en ambos casos; el código le dice a la caja si el
            // servicio no existe o solo se desactivó (SPEC 52 los trata distinto).
            if (!service) {
                throw notFound(`Servicio ${item.serviceId}`, 'PRODUCT_NOT_FOUND');
            }
            if (!service.isActive) {
                // Offline la venta ya se cobró: se registra y queda marcada
                // (`catalogReview`). En línea el cajero puede corregir.
                if (!input.offline) {
                    throw notFound(`Servicio ${item.serviceId}`, 'PRODUCT_INACTIVE');
                }
                if (!inactiveCatalogIds.includes(service.id)) {
                    inactiveCatalogIds.push(service.id);
                }
            }
            if (service.hasIeps && service.iepsRate === undefined) {
                throw badRequest(
                    `El servicio ${service.name} tiene IEPS sin tasa configurada (iepsRate)`,
                );
            }

            // El doctor se valida siempre que venga; que sea **obligatorio** lo
            // decide el catálogo (`requiresPerformer`), no el payload.
            let provider = null;
            if (item.providerId) {
                provider = await serviceProvidersRepo.getServiceProviderById(item.providerId);
                if (!provider || !provider.isActive) {
                    throw notFound(`Doctor ${item.providerId}`);
                }
            }
            if (service.requiresPerformer && !provider) {
                throw badRequest(
                    `El servicio ${service.name} requiere indicar quién lo realizó`,
                );
            }

            // Comisión congelada al cobrar: manda la del servicio y, solo si es 0,
            // se cae a la del doctor. El catálogo puede cambiar mañana; esta venta no.
            const commissionRate = service.commissionRate > 0
                ? service.commissionRate
                : provider?.defaultCommissionRate ?? 0;

            // Precio cobrado, no el del catálogo de ahora: el POS pudo cobrar
            // esta consulta horas antes y el precio pudo cambiar en el medio.
            // Mismo criterio que las partidas de mercancía.
            const unitPrice = item.unitPrice ?? service.price;
            const itemSubtotal = fromCents(toCents(unitPrice * item.quantity));
            const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
            subtotal += itemSubtotal;
            lineDiscountTotal += discountAmount;

            saleItems.push({
                kind: 'service',
                serviceId: service.id,
                serviceName: service.name,
                quantity: item.quantity,
                unitPrice,
                // Señal auditable de que se tarifó distinto del catálogo.
                ...(unitPrice !== service.price ? { catalogUnitPrice: service.price } : {}),
                discountAmount,
                subtotal: itemSubtotal,
                providerId: provider?.id ?? null,
                providerName: provider?.name ?? null,
                commissionRate,
                // Se calcula sobre el importe **neto**, que aún no se conoce: el
                // descuento a nivel venta se prorratea más abajo.
                commissionAmount: 0,
            });
            continue;
        }

        // Las promociones son por pieza: sobre una caja el paquete no tiene
        // sentido y la devolución no sabría recalcularlo (SPEC 46).
        const isBox = item.saleUnit === 'box';
        if (isBox && item.promotionId) {
            throw badRequest('Las promociones no aplican a la venta por caja');
        }

        let product = productCache.get(item.productId);
        if (!product) {
            product = preloadedProducts.get(item.productId) ?? null;
            productCache.set(item.productId, product);
        }

        if (!product) {
            throw notFound(`Producto ${item.productId}`, 'PRODUCT_NOT_FOUND');
        }
        if (!product.isActive) {
            // Mismo criterio que los servicios: offline se acepta y se marca.
            if (!input.offline) {
                throw notFound(`Producto ${item.productId}`, 'PRODUCT_INACTIVE');
            }
            if (!inactiveCatalogIds.includes(product.id)) {
                inactiveCatalogIds.push(product.id);
            }
        }

        if (isBox && !(product.boxQuantity && product.boxPrice)) {
            throw badRequest(`${product.name} no tiene configurada la venta por caja`);
        }
        // Todo lo que toca inventario (FEFO, lotes, movimientos, libro de
        // controlados, devoluciones) cuenta piezas; la caja solo decide cuántas.
        const piecesPerBox = isBox ? product.boxQuantity as number : 1;
        const pieces = item.quantity * piecesPerBox;

        // Un producto con IEPS y sin tasa haría un desglose fiscal inventado: se
        // corrige en el catálogo, no aquí (productos históricos pueden no tenerla).
        if (product.hasIeps && product.iepsRate === undefined) {
            throw badRequest(
                `El producto ${product.name} tiene IEPS sin tasa configurada (iepsRate)`,
            );
        }

        // Plan previo: validación temprana con el mensaje de siempre. **No decide
        // las asignaciones**: las de la venta salen del reparto transaccional
        // (SPEC 50). Descuenta sobre la copia en memoria para que dos partidas
        // del mismo producto (pieza y caja) se validen contra el total.
        const { allocations } = allocateSaleBatches(
            batchCache.get(item.productId) ?? [],
            pieces,
            product.name,
            { now: fefoNow, allowShortfall },
        );

        // Precio **cobrado**, no el de catálogo de hoy. Una venta sin conexión se
        // sincroniza horas o días después; si el precio subió entre medias, tarifar
        // con el nuevo dejaba el `amountReceived` corto y el backend rechazaba una
        // venta que el cliente ya había pagado. El catálogo solo manda cuando el
        // POS no informa precio (ventas anteriores a este campo).
        //
        // Por caja, `chargedPrice` es el precio de la caja y el subtotal es
        // `cajas × precio de caja` al centavo. Se guarda el precio efectivo por
        // pieza para que `unitPrice × quantity` (en piezas) siga dando el
        // subtotal en reportes, analítica y devoluciones.
        const catalogPrice = isBox ? product.boxPrice as number : product.salePrice;
        const chargedPrice = item.unitPrice ?? catalogPrice;
        const unitPrice = isBox ? chargedPrice / piecesPerBox : chargedPrice;
        const itemSubtotal = fromCents(toCents(chargedPrice * item.quantity));
        const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
        subtotal += itemSubtotal;
        lineDiscountTotal += discountAmount;

        const resolved = item.promotionId
            ? resolveLinePromotion({
                promotion: promotions.get(item.promotionId),
                promotionId: item.promotionId,
                productId: product.id,
                productName: product.name,
                unitPrice,
                quantity: item.quantity,
                discountAmount,
                atMs: promotionAtMs,
                graceMs: promotionGraceMs,
            })
            : null;
        const promotion: SaleItemPromotion | null = resolved?.promotion
            ? {
                ...resolved.promotion,
                ...(resolved.closed && input.offline ? { outOfWindow: true as const } : {}),
            }
            : null;
        if (resolved?.closed) {
            const name = promotions.get(item.promotionId!)?.name ?? item.promotionId!;
            if (input.offline) {
                if (promotion) {
                    outOfWindowPromotions.push(name);
                }
            } else if (!closedPromotionName) {
                closedPromotionName = name;
            }
        }

        saleItems.push({
            kind: 'product',
            productId: product.id,
            productName: product.name,
            quantity: pieces,
            unitPrice,
            // Precio de catálogo al momento de registrar. Se guarda solo cuando
            // difiere de lo cobrado: es la señal auditable de que el POS tarifó
            // distinto, y evita que un precio manipulado pase inadvertido. En
            // una partida por caja se compara el precio de caja.
            ...(chargedPrice !== catalogPrice ? { catalogUnitPrice: catalogPrice } : {}),
            ...(isBox
                ? {
                    saleUnit: {
                        type: 'box' as const,
                        boxes: item.quantity,
                        piecesPerBox,
                        boxPrice: chargedPrice,
                    },
                }
                : {}),
            discountAmount,
            subtotal: itemSubtotal,
            batchAllocations: allocations,
            ...(promotion ? { promotion } : {}),
        });
    }

    // Reglas de receta por grupo COFEPRIS (folio y retención en I a III).
    const cartProducts = [...productCache.values()].filter(Boolean) as Product[];
    const controlled = resolveControlledRequirements(cartProducts);
    assertPrescriptionRules({
        requirements: controlled,
        prescription: input.prescription,
        prescriptionRetained: input.prescriptionRetained,
    });

    const customerId: string | null = input.customerId ?? null;
    let customerName: string | null = input.customerName?.trim() ?? null;
    if (customerId) {
        const customer = await customersRepo.getCustomerById(customerId);
        if (!customer) {
            throw notFound('Cliente');
        }
        customerName = customerName || customer.name;
    }

    const billing = input.billing
        ? {
            rfc: input.billing.rfc.trim().toUpperCase(),
            name: input.billing.name.trim(),
            usoCfdi: input.billing.usoCfdi?.trim(),
            email: input.billing.email?.trim(),
        }
        : null;
    const prescription = input.prescription
        ? {
            doctorName: input.prescription.doctorName.trim(),
            doctorLicense: input.prescription.doctorLicense.trim(),
            folio: input.prescription.folio?.trim(),
        }
        : null;

    const saleDiscountAmount = Math.min(
        Math.max(0, input.saleDiscountAmount ?? 0),
        subtotal - lineDiscountTotal,
    );

    const resolvedCoupon = couponCode
        ? resolveSaleCoupon({
            code: couponCode,
            coupon: preloadedCoupon,
            items: saleItems,
            saleDiscountAmount,
            offline: Boolean(input.offline),
            atMs: promotionAtMs,
            graceMs: promotionGraceMs,
        })
        : null;
    // Solo un cupón que de verdad descontó algo se guarda y consume uso.
    const appliedCoupon = resolvedCoupon?.coupon && resolvedCoupon.totalCents > 0
        ? resolvedCoupon.coupon
        : null;
    if (appliedCoupon && appliedCoupon.scope === 'product') {
        resolvedCoupon!.lineParts.forEach((discountAmount, index) => {
            const item = saleItems[index];
            if (isSaleProductItem(item)) {
                item.coupon = { couponId: appliedCoupon.id, discountAmount };
            }
        });
    }
    const couponDiscountTotal = appliedCoupon ? fromCents(resolvedCoupon!.totalCents) : 0;
    const couponError = resolvedCoupon?.error ?? null;
    // A centavos: `3 x 10.10` en flotante es 30.299999999999997 y eso se guardaba tal
    // cual en la venta, en los reportes y en el desglose fiscal.
    const discountTotal = fromCents(toCents(lineDiscountTotal) + toCents(saleDiscountAmount));
    const total = fromCents(toCents(subtotal) - toCents(discountTotal));

    // El descuento a nivel venta se prorratea antes de desglosar impuestos: si no,
    // se declararía IVA sobre un importe que nunca se cobró.
    const lineNetsBeforeSaleDiscount = saleItems.map(
        (item) => item.subtotal - item.discountAmount,
    );
    const saleDiscountShares = prorateDiscount(
        lineNetsBeforeSaleDiscount,
        saleDiscountAmount,
    );

    saleItems.forEach((item, index) => {
        const netAmount = fromCents(
            toCents(lineNetsBeforeSaleDiscount[index]) - toCents(saleDiscountShares[index]),
        );
        item.saleDiscountShare = saleDiscountShares[index];
        item.netAmount = netAmount;

        if (isSaleServiceItem(item)) {
            const service = serviceCache.get(item.serviceId)!;
            item.taxes = breakdownLineTaxes({
                grossAmount: netAmount,
                // El `taxMode` del servicio se traduce a las mismas banderas
                // fiscales del producto: `exempt` y `zero` ⇒ IVA 0, `iva16` ⇒ 16 %.
                hasIva: service.taxMode === 'iva16',
                hasIvaZero: service.taxMode === 'zero',
                hasIeps: service.hasIeps,
                iepsRate: service.iepsRate,
            });
            // La comisión se acredita sobre lo realmente cobrado por la partida.
            item.commissionAmount = fromCents(
                Math.round((toCents(netAmount) * item.commissionRate) / 100),
            );
            return;
        }

        const product = productCache.get(item.productId)!;
        item.taxes = breakdownLineTaxes({
            grossAmount: netAmount,
            hasIva: product.hasIva,
            hasIvaZero: product.hasIvaZero,
            hasIeps: product.hasIeps,
            iepsRate: product.iepsRate,
        });
    });

    const taxSummary = sumTaxSummary(saleItems.map((item) => item.taxes!));

    // Las dos ramas de la venta. Son referencias a las mismas partidas de
    // `saleItems`, no copias: lo que se les escriba sigue viéndose en el documento.
    const productItems = saleItems.filter(isSaleProductItem);
    const serviceItems = saleItems.filter(isSaleServiceItem);

    // El tope es para el descuento **manual**: el de una promoción lo decidió la
    // gerencia al darla de alta, y un 2x1 (50%) no debe pedir un administrador.
    const promotionDiscountTotal = saleItems.reduce(
        (sum, item) => sum + (isSaleServiceItem(item) ? 0 : item.promotion?.discountAmount ?? 0),
        0,
    );
    const promotionIds = [...new Set(saleItems.flatMap((item) => (
        !isSaleServiceItem(item) && item.promotion ? [item.promotion.promotionId] : []
    )))];
    // El cupón tampoco es descuento manual: lo dio de alta la gerencia.
    const manualDiscount = (item: SaleLineItem): number => item.discountAmount -
        (isSaleServiceItem(item)
            ? 0
            : (item.promotion?.discountAmount ?? 0) + (item.coupon?.discountAmount ?? 0));
    // La base del tope es lo que queda **después** de la promo: si fuera el
    // subtotal de lista, un cajero podría sumar 20 % del precio lleno encima de
    // un 2x1 y dejar la partida al 70 % sin administrador.
    const isLineOverCap = (item: SaleLineItem): boolean => toCents(manualDiscount(item)) >
        toCents((item.subtotal - (item.discountAmount - manualDiscount(item))) *
            MAX_NON_ADMIN_DISCOUNT_RATE);
    const manualDiscountTotal = discountTotal - promotionDiscountTotal - couponDiscountTotal;
    const manualCapBase = subtotal - promotionDiscountTotal - couponDiscountTotal;

    const overCapLines = saleItems.filter(isLineOverCap);
    const discountOverCap = overCapLines.length > 0 ||
        toCents(manualDiscountTotal) > toCents(manualCapBase * MAX_NON_ADMIN_DISCOUNT_RATE);

    // Con un cupón que se va a rechazar no hay venta que topar: se omite para que
    // el cajero reciba el motivo real (o el reintento su venta), no un 403.
    if (input.roleSlug !== 'admin' && !couponError) {
        const lineOverCap = saleItems.find(isLineOverCap);
        if (lineOverCap) {
            throw forbidden(
                'Solo un administrador puede aplicar descuentos mayores al ' +
                `${MAX_NON_ADMIN_DISCOUNT_RATE * 100}% (${saleItemName(lineOverCap)})`,
            );
        }
        if (toCents(manualDiscountTotal) > toCents(manualCapBase * MAX_NON_ADMIN_DISCOUNT_RATE)) {
            throw forbidden(
                'Solo un administrador puede aplicar un descuento total mayor al ' +
                `${MAX_NON_ADMIN_DISCOUNT_RATE * 100}%`,
            );
        }
    }

    // Huella resuelta de siempre: se sigue guardando en `requestFingerprint` para
    // que un despliegue anterior (rollback) reconozca las llaves nuevas. La
    // revisión de idempotencia ya se hizo al principio con la del payload.
    const fingerprints: SaleFingerprints = {
        payload: payloadFingerprint,
        resolved: buildRequestFingerprint({
            items: saleItems,
            total,
            paymentMethod: input.paymentMethod,
            cashSessionId: input.cashSessionId,
            couponCode,
        }),
    };

    if (closedPromotionName) {
        throw badRequest(`La promoción "${closedPromotionName}" no está vigente`);
    }
    if (couponError) {
        throw badRequest(couponError);
    }
    const couponRef = appliedCoupon
        ? couponsRepo.couponsCollection().doc(appliedCoupon.id)
        : null;

    // La order Point se resuelve ANTES del tender: en pago mixto su monto es lo que
    // define cuánto falta cubrir en efectivo.
    const pointPayment = await resolvePointPayment({
        paymentMethod: input.paymentMethod,
        orderId: input.cardPaymentReference ?? null,
        saleTotal: total,
    });
    const tender = resolveTender({
        paymentMethod: input.paymentMethod,
        total,
        amountReceived: input.amountReceived,
        cardPaymentReference: input.cardPaymentReference,
        // La order manda cuando existe; si no, el reparto capturado en el POS.
        ...(pointPayment
            ? { cardAmount: Number(pointPayment.amount) }
            : input.cardAmount !== undefined && input.cardAmount !== null
                ? { cardAmount: input.cardAmount }
                : {}),
    });

    /**
     * Denormalizados del cobro de servicios. **Los decide el servidor**: el
     * payload propone partidas, no totales.
     *
     * `pharmacyTotal` se obtiene restando en centavos, no sumando la rama de
     * mercancía, para que `pharmacyTotal + servicesTotal === total` se cumpla
     * exacto y no dependa del redondeo de cada partida.
     */
    const servicesTotalCents = serviceItems.reduce(
        (sum, item) => sum + toCents(item.netAmount ?? 0),
        0,
    );
    const servicesTotal = fromCents(servicesTotalCents);
    const pharmacyTotal = fromCents(toCents(total) - servicesTotalCents);
    const commissionTotalCents = serviceItems.reduce(
        (sum, item) => sum + toCents(item.commissionAmount),
        0,
    );
    const commissionByProviderCents = new Map<string, number>();
    for (const item of serviceItems) {
        if (!item.providerId) {
            continue;
        }
        commissionByProviderCents.set(
            item.providerId,
            (commissionByProviderCents.get(item.providerId) ?? 0) +
                toCents(item.commissionAmount),
        );
    }

    /**
     * Reparto del efectivo: **servicios primero**. El efectivo cubre los
     * servicios y lo que sobra es de farmacia; no se prorratea. Es una regla del
     * negocio, no una aproximación.
     */
    const cashAmountCents = toCents(tender.cashAmount ?? 0);
    const servicesCashCents = Math.min(cashAmountCents, servicesTotalCents);
    const servicesCashAmount = fromCents(servicesCashCents);
    const pharmacyCashAmount = fromCents(cashAmountCents - servicesCashCents);

    /** La transacción devolvió una venta ya registrada (reintento): sin bitácora nueva. */
    let replayed = false;
    /** Partidas con faltante de stock en el último intento de la transacción. */
    let stockReviewItems: SaleStockReviewItem[] = [];
    let wroteLedger = false;

    const sale = await firestore.runTransaction(async (transaction) => {
        replayed = false;
        stockReviewItems = [];
        wroteLedger = false;
        // Segundo chequeo dentro de la transacción: dos requests simultáneos con la
        // misma llave contienden por este documento y el perdedor reintenta, ve la
        // venta ya escrita y la devuelve en lugar de duplicarla.
        const idemDoc = idempotencyRef ? await transaction.get(idempotencyRef) : null;
        if (idemDoc?.exists) {
            const existingSaleDoc = await transaction.get(
                firestore.collection('sales').doc(idemDoc.data()!.saleId as string),
            );
            replayed = true;
            return resolveReplayedSale(idemDoc, existingSaleDoc, fingerprints);
        }

        // Cupón: `usedCount` se lee aquí, antes de cualquier escritura. Dos ventas
        // en línea sobre el último uso contienden por este documento y la segunda,
        // al reintentar, ve el uso consumido y se rechaza. Offline nunca se
        // rechaza: se acepta y queda marcada.
        let couponReview: SaleCouponReview | null = resolvedCoupon?.review ?? null;
        let couponUsedCount: number | null = null;
        if (couponRef && appliedCoupon) {
            const couponDoc = await transaction.get(couponRef);
            const fresh = couponDoc.exists ? couponsRepo.toCoupon(couponDoc) : appliedCoupon;
            couponUsedCount = fresh.usedCount ?? 0;
            if (!input.offline) {
                if (!couponDoc.exists || isCouponClosed(fresh, timestamp.toMillis(), 0)) {
                    throw badRequest(`El cupón ${appliedCoupon.code} no está vigente`);
                }
                if (isCouponExhausted(fresh)) {
                    throw badRequest(
                        `El cupón ${appliedCoupon.code} ya alcanzó su límite de usos`,
                    );
                }
            } else if (!couponReview && isCouponExhausted(fresh)) {
                couponReview = { reason: 'over_limit', code: appliedCoupon.code };
            }
        }

        // Solo mercancía: los reportes resuelven cada id de `productIds` contra
        // `products`, así que un id de servicio aquí los revienta.
        const productIds = [...new Set(productItems.map((item) => item.productId))];

        // Todas las lecturas antes de cualquier escritura, en paralelo. Los lotes
        // se leen **por consulta** (`productId`, `quantity > 0`) dentro de la
        // transacción (SPEC 50): si otra caja vació un lote entre el plan y aquí,
        // Firestore reintenta este callback y el reparto se rehace sobre el
        // estado fresco, en vez de rechazar con stock en otro lote.
        const [cashSessionDoc, counterDoc, productDocs, batchSnapshots] = await Promise.all([
            transaction.get(cashSessionRef),
            transaction.get(counterRef),
            Promise.all(productIds.map((productId) =>
                transaction.get(firestore.collection('products').doc(productId)))),
            Promise.all(productIds.map((productId) =>
                transaction.get(batchesRepo.availableBatchesQuery(productId)))),
        ]);

        if (!cashSessionDoc.exists) {
            throw notFound('Turno de caja');
        }
        // El turno es de quien lo abrió: sin esto un cajero puede cargar ventas en
        // efectivo al turno de otro y dejarle el faltante en su corte.
        assertCanAccessSession(
            { openedBy: cashSessionDoc.data()!.openedBy as string },
            input.cashierId,
            input.roleSlug,
        );
        // Turno cerrado (SPEC 52): una venta offline cobrada **antes** del cierre
        // se registra en ese turno marcada `lateSync`, y el turno queda con ajuste
        // pendiente y el efectivo que llegó tarde en `lateSales`. Cobrada después
        // del cierre (o sin fecha de cobro creíble, que entonces es la de
        // recepción) sigue siendo un rechazo.
        const sessionClosedAt = cashSessionDoc.data()?.closedAt as Timestamp | null | undefined;
        const lateSync = Boolean(sessionClosedAt) && Boolean(input.offline) &&
            businessAt.toMillis() <= sessionClosedAt!.toMillis();
        if (sessionClosedAt && !lateSync) {
            throw badRequest('El turno de caja ya está cerrado', 'SESSION_CLOSED');
        }

        const nextSequence = (counterDoc.data()?.value as number | undefined ?? 0) + 1;
        const folio = buildFolio(nextSequence);

        // Reparto FEFO transaccional: es el que decide `batchAllocations`, el
        // costo y los lotes del libro. Se rehace completo en cada intento de la
        // transacción (las partidas se sobrescriben, no se acumulan).
        const batchById = new Map<string, Batch>();
        // Suma de lotes ANTES de asignar. Si `products.totalStock` no existe
        // (productos previos a la denormalización), es la base del descuento.
        const batchStockBefore = new Map<string, number>();
        const workingBatches = new Map<string, Batch[]>();
        productIds.forEach((productId, index) => {
            const batches = batchesRepo.toBatchesByExpiry(batchSnapshots[index].docs);
            batches.forEach((batch) => batchById.set(batch.id, batch));
            batchStockBefore.set(
                productId,
                batches.reduce((sum, batch) => sum + batch.quantity, 0),
            );
            // Copias: `allocateSaleBatches` descuenta sobre ellas, los originales
            // conservan la existencia leída para escribir `quantity − tomado`.
            workingBatches.set(productId, batches.map((batch) => ({ ...batch })));
        });
        const takenByBatchId = new Map<string, number>();
        // Piezas que de verdad salen de lotes, por producto: es lo que baja
        // `totalStock`. Con faltante (offline) es menos de lo cobrado.
        const stockDeltaByProduct = new Map<string, number>();
        for (const item of productItems) {
            const { allocations, shortfall } = allocateSaleBatches(
                workingBatches.get(item.productId) ?? [],
                item.quantity,
                item.productName,
                { now: fefoNow, allowShortfall },
            );
            item.batchAllocations = allocations;
            // Se rehace en cada intento: un reintento con más stock no deja el
            // faltante del intento anterior.
            delete item.stockShortfall;
            if (shortfall > 0) {
                item.stockShortfall = shortfall;
                stockReviewItems.push({
                    productId: item.productId,
                    requested: item.quantity,
                    allocated: item.quantity - shortfall,
                    shortfall,
                });
            }
            for (const allocation of item.batchAllocations) {
                takenByBatchId.set(
                    allocation.batchId,
                    (takenByBatchId.get(allocation.batchId) ?? 0) + allocation.quantity,
                );
            }
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + item.quantity - shortfall,
            );
        }

        // COGS por partida desde el costo de los lotes asignados. Si a un lote le
        // falta `costPrice`, la partida queda en `null` y el reporte de margen la
        // reporta como "sin costo" en lugar de inflar la utilidad con un cero. Un
        // servicio no tiene costo de mercancía: queda fuera, no cuenta como "sin
        // costo".
        for (const item of productItems) {
            let costCents = 0;
            // Con faltante, el costo de las piezas que no salieron de ningún lote
            // no se conoce: la partida queda "sin costo" (`salesWithoutCost`) en
            // vez de reportar un margen inflado (SPEC 52).
            let costKnown = !item.stockShortfall;
            for (const allocation of costKnown ? item.batchAllocations : []) {
                const costPrice = batchById.get(allocation.batchId)?.costPrice;
                if (costPrice === undefined) {
                    costKnown = false;
                    break;
                }
                costCents += toCents(costPrice) * allocation.quantity;
            }
            item.costAmount = costKnown ? costCents / 100 : null;
        }
        const costTotal = productItems.every((item) => item.costAmount !== null)
            ? productItems.reduce((sum, item) => sum + (item.costAmount ?? 0), 0)
            : null;

        takenByBatchId.forEach((taken, batchId) => {
            transaction.update(firestore.collection('batches').doc(batchId), {
                quantity: batchById.get(batchId)!.quantity - taken,
                updatedAt: timestamp,
            });
        });

        for (const item of productItems) {
            for (const allocation of item.batchAllocations) {
                const movementRef = firestore.collection('stockMovements').doc();
                transaction.set(movementRef, {
                    type: 'sale_adjustment',
                    productId: item.productId,
                    batchId: allocation.batchId,
                    quantity: allocation.quantity,
                    referenceId: saleRef.id,
                    userId: input.cashierId,
                    // Fecha del hecho = fecha de negocio (SPEC 51); la de registro
                    // queda en `recordedAt`.
                    createdAt: businessAt,
                    recordedAt: timestamp,
                });
            }
        }

        transaction.set(counterRef, { value: nextSequence }, { merge: true });

        if (lateSync) {
            // Mismo turno, mismo cajón: el efectivo de la venta tardía no está en
            // el corte congelado, así que el turno vuelve a pedir revisión aunque
            // su ajuste ya se hubiera aprobado. Se suma sobre lo leído en esta
            // transacción, en centavos.
            const previous = cashSessionDoc.data()?.lateSales as
                { count?: number; cashTotal?: number } | undefined;
            transaction.update(cashSessionRef, {
                hasPendingAdjustment: true,
                adjustmentStatus: 'pending',
                lateSales: {
                    count: (previous?.count ?? 0) + 1,
                    cashTotal: fromCents(
                        toCents(previous?.cashTotal ?? 0) + toCents(tender.cashAmount ?? 0),
                    ),
                },
            });
        }

        // El uso se consume en la misma transacción que la venta. `updatedAt`
        // sube para que el pull del POS traiga el `usedCount` nuevo. Anular o
        // devolver la venta no devuelve el uso.
        if (couponRef && couponUsedCount !== null) {
            transaction.update(couponRef, {
                usedCount: couponUsedCount + 1,
                updatedAt: timestamp,
            });
        }
        const saleCoupon: SaleCoupon | null = appliedCoupon
            ? {
                couponId: appliedCoupon.id,
                code: appliedCoupon.code,
                name: appliedCoupon.name,
                scope: appliedCoupon.scope,
                discount: appliedCoupon.discount,
                discountAmount: couponDiscountTotal,
            }
            : null;

        productIds.forEach((productId, index) => {
            const delta = stockDeltaByProduct.get(productId) ?? 0;
            const denorm = productDocs[index].data()?.totalStock;
            const baseline = typeof denorm === 'number'
                ? denorm
                : (batchStockBefore.get(productId) ?? delta);
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: Math.max(0, baseline - delta),
                updatedAt: timestamp,
            });
        });

        const saleData = {
            folio,
            productIds,
            items: saleItems,
            subtotal,
            discountTotal,
            total,
            taxSummary,
            costTotal,
            ...(promotionIds.length
                ? {
                    promotionDiscountTotal: fromCents(toCents(promotionDiscountTotal)),
                    promotionIds,
                    ...(outOfWindowPromotions.length ? { promotionReview: true as const } : {}),
                }
                : {}),
            ...(saleCoupon ? { coupon: saleCoupon, couponDiscountTotal } : {}),
            ...(couponReview ? { couponReview } : {}),
            // Marcas de revisión de la venta offline (SPEC 52).
            ...(stockReviewItems.length ? { stockReview: { items: stockReviewItems } } : {}),
            ...(inactiveCatalogIds.length
                ? { catalogReview: { inactive: [...inactiveCatalogIds] } }
                : {}),
            ...(lateSync ? { lateSync: true as const } : {}),
            refundedTotal: 0,
            paymentMethod: input.paymentMethod,
            amountReceived: tender.amountReceived,
            change: tender.change,
            cashAmount: tender.cashAmount,
            cardAmount: tender.cardAmount,
            cardPaymentReference: pointPayment?.orderId ?? tender.cardPaymentReference,
            pointPayment,
            cashSessionId: input.cashSessionId,
            cashierId: input.cashierId,
            customerId,
            customerName,
            prescription,
            prescriptionRetained: Boolean(input.prescriptionRetained),
            controlledGroups: controlled.groups,
            hasServices: serviceItems.length > 0,
            serviceIds: [...new Set(serviceItems.map((item) => item.serviceId))],
            providerIds: [...commissionByProviderCents.keys()],
            commissionTotal: fromCents(commissionTotalCents),
            commissionByProvider: Object.fromEntries(
                [...commissionByProviderCents].map(([providerId, cents]) => [
                    providerId,
                    fromCents(cents),
                ]),
            ),
            pharmacyTotal,
            servicesTotal,
            pharmacyCashAmount,
            servicesCashAmount,
            billing,
            invoiceStatus: billing ? ('pending' as const) : null,
            voidedAt: null,
            voidedBy: null,
            createdAt: timestamp,
            // Fecha de negocio (SPEC 51): la de los reportes, el libro y `dailyStats`.
            businessAt,
            soldAt: hasSoldAt ? Timestamp.fromMillis(soldAtMs) : null,
            soldAtTrusted: trustedSoldAt,
        };

        if (idempotencyRef) {
            transaction.create(idempotencyRef, {
                saleId: saleRef.id,
                folio,
                cashierId: input.cashierId,
                requestFingerprint: fingerprints.resolved,
                payloadFingerprint: fingerprints.payload,
                createdAt: timestamp,
                // Campo para la política TTL de Firestore sobre esta colección.
                expiresAt: Timestamp.fromMillis(
                    timestamp.toMillis() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
                ),
            });
        }

        // Libro de control: un renglón por partida de grupo controlado, en la misma
        // transacción que la venta. Un servicio no es una sustancia controlada:
        // la rama de servicios no entra al libro.
        for (const item of productItems) {
            const rule = getControlledRule(productCache.get(item.productId)?.controlledGroup);
            if (!rule?.requiresLedger) {
                continue;
            }
            writeLedgerEntryInTransaction(transaction, {
                type: 'sale',
                saleId: saleRef.id,
                saleFolio: folio,
                referenceFolio: null,
                productId: item.productId,
                productName: item.productName,
                controlledGroup: rule.group,
                quantity: item.quantity,
                lotNumbers: item.batchAllocations
                    .map((allocation) => batchById.get(allocation.batchId)?.lotNumber)
                    .filter((lot): lot is string => Boolean(lot)),
                prescription,
                prescriptionRetained: Boolean(input.prescriptionRetained),
                customerName,
                userId: input.cashierId,
                // El renglón lleva la fecha del cobro (SPEC 51); con faltante de
                // stock registra igual la cantidad completa: la salida física
                // ocurrió (SPEC 52).
                createdAt: businessAt,
                recordedAt: timestamp,
            });
            wroteLedger = true;
        }

        transaction.set(saleRef, saleData);
        dailyStatsRepo.applySaleDelta(
            transaction,
            { createdAt: businessAt.toDate(), totalCents: toCents(saleData.total) },
            1,
        );
        return { id: saleRef.id, ...saleData };
    });

    if (!replayed) {
        await recordOfflineReviewAudits({
            sale,
            cashierId: input.cashierId,
            roleSlug: input.roleSlug ?? null,
            soldAt: input.soldAt ?? null,
            soldAtUntrustedReason,
            sessionOpenedAt: preloadedSession?.openedAt ?? null,
            stockReviewItems,
            inactiveCatalogIds,
            wroteLedger,
            recordedAt: timestamp,
        });
    }

    if (sale.couponReview) {
        const reasons: Record<SaleCouponReview['reason'], string> = {
            out_of_window: 'fuera de vigencia',
            over_limit: 'sin usos disponibles',
            not_found: 'que el servidor no conoce (descuento tratado como manual)',
        };
        await recordAudit({
            action: 'sale.coupon_review',
            entity: 'sale',
            entityId: sale.id,
            summary: `Venta ${sale.folio} sincronizada con el cupón ${sale.couponReview.code} ` +
                reasons[sale.couponReview.reason],
            userId: input.cashierId,
            roleSlug: input.roleSlug ?? null,
            metadata: {
                folio: sale.folio,
                soldAt: input.soldAt ?? null,
                soldAtTrusted: trustedSoldAt,
                reason: sale.couponReview.reason,
                couponCode: sale.couponReview.code,
                couponDiscountTotal,
            },
        });
    }

    if (outOfWindowPromotions.length) {
        await recordAudit({
            action: 'sale.promotion_out_of_window',
            entity: 'sale',
            entityId: sale.id,
            summary: `Venta ${sale.folio} sincronizada con promoción fuera de vigencia: ` +
                [...new Set(outOfWindowPromotions)].join(', '),
            userId: input.cashierId,
            roleSlug: input.roleSlug ?? null,
            metadata: {
                folio: sale.folio,
                soldAt: input.soldAt ?? null,
                soldAtTrusted: trustedSoldAt,
                promotionDiscountTotal,
                promotions: [...new Set(outOfWindowPromotions)],
            },
        });
    }

    // Descuento por encima del tope: lo permitió un administrador, así que queda
    // en la bitácora con el monto y quién lo autorizó.
    if (discountOverCap) {
        await recordAudit({
            action: 'sale.discount_override',
            entity: 'sale',
            entityId: sale.id,
            summary: `Descuento de ${discountTotal.toFixed(2)} sobre ${subtotal.toFixed(2)} ` +
                `en la venta ${sale.folio} (arriba del ${MAX_NON_ADMIN_DISCOUNT_RATE * 100}%)`,
            userId: input.cashierId,
            roleSlug: input.roleSlug ?? null,
            metadata: {
                folio: sale.folio,
                subtotal,
                discountTotal,
                lineOverCap: overCapLines.map((item) => ({
                    productId: isSaleServiceItem(item) ? item.serviceId : item.productId,
                    productName: saleItemName(item),
                    discountAmount: item.discountAmount,
                })),
            },
        });
    }

    return sale;
};

/** Mes local (`YYYY-MM`) de un instante, en el huso de la farmacia. */
const localMonthOf = (at: Timestamp): string =>
    getZonedYmd(at.toMillis(), APP_TIME_ZONE).slice(0, 7);

/**
 * Bitácora de las marcas de una venta offline (SPEC 51 y 52). Solo para una venta
 * recién escrita: el reintento que devuelve la venta ya registrada no repite
 * renglones. `recordAudit` se traga sus errores: la venta ya está confirmada.
 */
const recordOfflineReviewAudits = async (input: {
    sale: Pick<Sale, 'id' | 'folio' | 'lateSync' | 'cashSessionId' | 'cashAmount'> & {
        businessAt?: Timestamp;
    };
    cashierId: string;
    roleSlug: string | null;
    soldAt: string | null;
    soldAtUntrustedReason: SoldAtUntrustedReason | null;
    sessionOpenedAt: Timestamp | null;
    stockReviewItems: SaleStockReviewItem[];
    inactiveCatalogIds: string[];
    wroteLedger: boolean;
    recordedAt: Timestamp;
}): Promise<void> => {
    const { sale } = input;
    const base = {
        entity: 'sale' as const,
        entityId: sale.id,
        userId: input.cashierId,
        roleSlug: input.roleSlug,
    };

    // El reloj adelantado es la regla de siempre (SPEC 65 se ocupa del reloj);
    // aquí solo las dos causas nuevas.
    if (input.soldAtUntrustedReason === 'before_session' ||
        input.soldAtUntrustedReason === 'too_old') {
        await recordAudit({
            ...base,
            action: 'sale.sold_at_untrusted',
            summary: `Venta ${sale.folio}: la hora de cobro de la caja ` +
                (input.soldAtUntrustedReason === 'before_session'
                    ? 'es anterior a la apertura del turno'
                    : 'tiene más de 7 días') +
                '; queda con la fecha de recepción',
            metadata: {
                folio: sale.folio,
                soldAt: input.soldAt,
                reason: input.soldAtUntrustedReason,
                sessionOpenedAt: input.sessionOpenedAt?.toDate().toISOString() ?? null,
                recordedAt: input.recordedAt.toDate().toISOString(),
            },
        });
    }

    if (input.stockReviewItems.length) {
        const pieces = input.stockReviewItems.reduce((sum, item) => sum + item.shortfall, 0);
        await recordAudit({
            ...base,
            action: 'sale.stock_shortfall',
            summary: `Venta ${sale.folio} sincronizada con faltante de stock: ` +
                `${pieces} ${pieces === 1 ? 'pieza' : 'piezas'} sin lote`,
            metadata: { folio: sale.folio, items: input.stockReviewItems },
        });
    }

    if (input.inactiveCatalogIds.length) {
        await recordAudit({
            ...base,
            action: 'sale.catalog_review',
            summary: `Venta ${sale.folio} sincronizada con productos o servicios inactivos`,
            metadata: { folio: sale.folio, inactive: input.inactiveCatalogIds },
        });
    }

    if (sale.lateSync) {
        await recordAudit({
            ...base,
            action: 'sale.late_sync',
            summary: `Venta ${sale.folio} cobrada antes del cierre y sincronizada con el ` +
                'turno ya cerrado: el turno queda con ajuste pendiente',
            metadata: {
                folio: sale.folio,
                cashSessionId: sale.cashSessionId,
                cashAmount: sale.cashAmount ?? null,
            },
        });
    }

    // Libro de controlados: el renglón cae en el mes del cobro. Si ya pasó ese
    // mes, el libro exportado de entonces cambió y hay que reexportarlo.
    if (input.wroteLedger && sale.businessAt &&
        localMonthOf(sale.businessAt) < localMonthOf(input.recordedAt)) {
        await recordAudit({
            ...base,
            action: 'sale.late_ledger_entry',
            summary: `Venta ${sale.folio} de controlados registrada en el libro de ` +
                `${localMonthOf(sale.businessAt)} después de cerrado ese mes: ` +
                'reexporta el libro de ese periodo',
            metadata: {
                folio: sale.folio,
                businessAt: sale.businessAt.toDate().toISOString(),
                recordedAt: input.recordedAt.toDate().toISOString(),
            },
        });
    }
};

/**
 * Anula una venta. Mismo contrato de códigos que `createSale` (SPEC 49): ya
 * anulada, con devoluciones, sin permiso o turno ajeno llevan el suyo; lo demás es
 * `VALIDATION`.
 */
export const voidSale = async (...args: Parameters<typeof applyVoid>): Promise<Sale> => {
    try {
        return await applyVoid(...args);
    } catch (error) {
        throw withDefaultSyncCode(error, 'VALIDATION');
    }
};

const applyVoid = async (
    id: string,
    voidedBy: string,
    roleSlug?: string,
    /**
     * Datos que reporta el POS cuando la anulación ocurrió **sin red** y se está
     * cerrando en el siguiente sync: el instante y el cajero de entonces. Sin
     * esto, la venta quedaría anulada con la hora del sync y a nombre de quien
     * sincronizó, que puede ser otro turno y otra persona.
     */
    reported?: { voidedAt?: string; voidedBy?: string },
): Promise<Sale> => {
    const firestore = db();
    const saleRef = firestore.collection('sales').doc(id);

    // Fuera de la transacción: Firestore exige que todas sus lecturas ocurran
    // antes de cualquier escritura, y esto solo decide quién puede anular.
    const saleSnapshot = await saleRef.get();
    const sesionId = saleSnapshot.exists
        ? ((saleSnapshot.data()?.cashSessionId as string | null) ?? null)
        : null;
    const sesion = sesionId ? await cashSessionsRepo.getCashSessionById(sesionId) : null;
    const sesionCerrada = Boolean(sesion?.closedAt);
    // Mismo criterio que vender, devolver y operar el turno: un turno abierto es de
    // quien lo abrió (o de un admin). Sin esto un cajero anulaba las ventas del turno
    // de un compañero y le bajaba el efectivo esperado de su corte.
    if (sesion && !sesion.closedAt) {
        assertCanAccessSession(sesion, voidedBy, roleSlug ?? '');
    }

    const sale = await firestore.runTransaction(async (transaction) => {
        const saleDoc = await transaction.get(saleRef);
        if (!saleDoc.exists) {
            throw notFound('Venta');
        }
        const existing = mapSaleDoc(saleDoc);
        if (existing.voidedAt) {
            throw badRequest('La venta ya está anulada', 'ALREADY_VOIDED');
        }
        // Anular después de devolver parcialmente restauraría stock dos veces y
        // devolvería dinero de más: primero se cancela la devolución.
        // Un turno cerrado ya tiene su arqueo firmado: cambiarle una venta lo
        // descuadra hacia atrás. Ahí la anulación deja de ser rutina de
        // mostrador y pasa a ser decisión de administración.
        if (sesionCerrada && roleSlug !== 'admin') {
            throw forbidden(
                'La venta pertenece a un turno ya cerrado: solo un administrador puede anularla',
                'VOID_FORBIDDEN',
            );
        }
        if ((existing.refundedTotal ?? 0) > 0) {
            throw conflict(
                'La venta tiene devoluciones registradas; no se puede anular completa',
                'HAS_RETURNS',
            );
        }

        /**
         * La anulación solo revierte la rama de mercancía: reposición de lotes,
         * movimientos negativos y contra-asiento del libro. Las partidas de
         * servicio no dejaron rastro que revertir —solo quedan marcadas por el
         * `voidedAt`/`voidedBy` de la venta.
         */
        const voidedProductItems = existing.items.filter(isSaleProductItem);

        const batchRefs = voidedProductItems.flatMap((item) =>
            item.batchAllocations.map((allocation) => ({
                item,
                allocation,
                batchRef: firestore.collection('batches').doc(allocation.batchId),
            })),
        );

        const restoreByBatchId = new Map<string, {
            batchRef: FirebaseFirestore.DocumentReference;
            quantity: number;
        }>();
        for (const { allocation, batchRef } of batchRefs) {
            const existingRestore = restoreByBatchId.get(allocation.batchId);
            if (existingRestore) {
                existingRestore.quantity += allocation.quantity;
            } else {
                restoreByBatchId.set(allocation.batchId, {
                    batchRef,
                    quantity: allocation.quantity,
                });
            }
        }
        const uniqueRestores = [...restoreByBatchId.entries()];

        const productIds = [...new Set(voidedProductItems.map((item) => item.productId))];
        const [batchDocs, productDocs] = await Promise.all([
            Promise.all(uniqueRestores.map(([, entry]) => transaction.get(entry.batchRef))),
            Promise.all(productIds.map((productId) =>
                transaction.get(firestore.collection('products').doc(productId)))),
        ]);

        const productGroupById = new Map<string, ControlledGroup | undefined>();
        productIds.forEach((productId, index) => {
            productGroupById.set(
                productId,
                productDocs[index].data()?.controlledGroup as ControlledGroup | undefined,
            );
        });

        /**
         * Instante de la anulación. Se acepta el reportado por la caja solo si
         * es coherente —no futuro y no anterior a la venta—: un reloj desfasado
         * en el equipo no debe escribir una línea de tiempo imposible en la
         * bitácora ni en el libro de control.
         */
        const serverNow = now();
        const reportedAt = reported?.voidedAt
            ? Timestamp.fromDate(new Date(reported.voidedAt))
            : null;
        // El piso es la fecha de negocio (SPEC 51): una venta offline anulada en la
        // caja antes de sincronizar tiene `createdAt` posterior a su anulación.
        const reportedIsSane = reportedAt !== null &&
            reportedAt.toMillis() <= serverNow.toMillis() &&
            reportedAt.toMillis() >= saleBusinessAt(existing).toMillis();
        const timestamp = reportedIsSane ? reportedAt : serverNow;
        // El cajero reportado solo se respeta cuando es quien está llamando o lo manda un
        // admin: antes cualquiera firmaba la anulación (y sus movimientos y el libro de
        // controlados) a nombre de otro usuario.
        const author = reported?.voidedBy &&
            (reported.voidedBy === voidedBy || roleSlug === 'admin')
            ? reported.voidedBy
            : voidedBy;

        uniqueRestores.forEach(([, entry], index) => {
            const batchDoc = batchDocs[index];
            if (!batchDoc.exists) {
                throw notFound('Lote');
            }
            const currentQty = batchDoc.data()?.quantity as number;
            // `updatedAt` de lotes y productos es el cursor del pull de las cajas:
            // siempre hora del servidor (SPEC 56). Con la hora reportada de una
            // anulación offline quedaba en el pasado y las cajas se la saltaban.
            transaction.update(entry.batchRef, {
                quantity: currentQty + entry.quantity,
                updatedAt: serverNow,
            });
        });

        batchRefs.forEach(({ item, allocation }) => {
            const movementRef = firestore.collection('stockMovements').doc();
            transaction.set(movementRef, {
                type: 'sale_adjustment',
                productId: item.productId,
                batchId: allocation.batchId,
                quantity: -allocation.quantity,
                referenceId: saleRef.id,
                userId: author,
                // La hora reportada es la del hecho; la de registro, la del servidor.
                createdAt: timestamp,
                recordedAt: serverNow,
            });
        });

        // Vuelve lo que salió de lotes, no lo cobrado: una partida con faltante
        // (SPEC 52) solo descontó `batchAllocations`.
        const stockDeltaByProduct = new Map<string, number>();
        for (const item of voidedProductItems) {
            const allocated = item.batchAllocations
                .reduce((sum, allocation) => sum + allocation.quantity, 0);
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + allocated,
            );
        }
        productIds.forEach((productId, index) => {
            const delta = stockDeltaByProduct.get(productId) ?? 0;
            const denorm = productDocs[index].data()?.totalStock;
            const baseline = typeof denorm === 'number' ? denorm : 0;
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: Math.max(0, baseline + delta),
                updatedAt: serverNow,
            });
        });

        // Reversa en el libro de control: cantidad negativa, un renglón por partida
        // controlada. El libro nunca se borra, se contra-asienta.
        for (const item of voidedProductItems) {
            const group = productGroupById.get(item.productId);
            const rule = getControlledRule(group);
            if (!rule?.requiresLedger) {
                continue;
            }
            writeLedgerEntryInTransaction(transaction, {
                type: 'void',
                saleId: existing.id,
                saleFolio: existing.folio,
                referenceFolio: null,
                productId: item.productId,
                productName: item.productName,
                controlledGroup: rule.group,
                quantity: -item.quantity,
                lotNumbers: [],
                prescription: existing.prescription,
                prescriptionRetained: Boolean(existing.prescriptionRetained),
                customerName: existing.customerName,
                userId: author,
                createdAt: timestamp,
                recordedAt: serverNow,
            });
        }

        transaction.update(saleRef, { voidedAt: timestamp, voidedBy: author });
        // Resta del día en que se hizo la venta (su fecha de negocio, SPEC 51), no
        // del día de la anulación.
        dailyStatsRepo.applySaleDelta(
            transaction,
            {
                createdAt: saleBusinessAt(existing).toDate(),
                totalCents: toCents(existing.total),
            },
            -1,
        );

        return { ...existing, voidedAt: timestamp, voidedBy: author };
    });

    await recordAudit({
        action: 'sale.voided',
        entity: 'sale',
        entityId: sale.id,
        summary: `Venta ${sale.folio} anulada por ${sale.total.toFixed(2)}`,
        userId: voidedBy,
        roleSlug: roleSlug ?? null,
        metadata: {
            folio: sale.folio,
            total: sale.total,
            paymentMethod: sale.paymentMethod,
            items: sale.items.length,
            // Anulación hecha sin red y cerrada en el sync: quién la hizo en la
            // caja y cuándo, frente a quién la sincronizó (`userId`).
            ...(reported?.voidedBy || reported?.voidedAt
                ? {
                    offlineVoid: true,
                    reportedVoidedBy: reported?.voidedBy ?? null,
                    reportedVoidedAt: reported?.voidedAt ?? null,
                }
                : {}),
        },
    });

    return sale;
};

export const getSale = async (id: string): Promise<Sale> => {
    const sale = await salesRepo.getSaleById(id);
    if (!sale) {
        throw notFound('Venta');
    }
    return sale;
};

/**
 * Comprueba que quien pregunta tenga derecho a ver ESTA venta, aplicando al
 * turno de la venta la misma regla que el resto del módulo de caja: el cajero
 * que lo abrió, o un administrador.
 *
 * Sin esto, `sales:read` (que tiene el mostrador) era una lectura universal por
 * id: cualquier cajero podía leer el detalle —partidas, cliente, forma de pago,
 * totales— de cualquier venta de cualquier compañero, y el ticket completo por
 * `/:id/receipt`. Se separa de `getSale` a propósito para no cambiar las
 * llamadas internas del propio backend, que ya validan por su cuenta.
 */
export const assertCanReadSale = async (
    sale: Sale,
    requesterId: string,
    roleSlug?: string | null,
): Promise<void> => {
    if (!sale.cashSessionId) {
        // Venta sin turno (cobro directo, migración): no hay pertenencia que
        // comprobar, así que solo la ve un administrador.
        assertCanAccessSession({ openedBy: '' }, requesterId, roleSlug);
        return;
    }
    const session = await cashSessionsRepo.getCashSessionById(sale.cashSessionId);
    // Turno inexistente: no se puede acreditar la pertenencia, así que se niega
    // a todo el que no sea administrador en vez de dejarlo pasar.
    assertCanAccessSession({ openedBy: session?.openedBy ?? '' }, requesterId, roleSlug);
};

export const listSales = async (filters: {
    from?: string;
    to?: string;
    cashSessionId?: string;
    includeVoided?: boolean;
    search?: string;
    /** Solo las marcadas con `promotionReview` (promo aceptada fuera de vigencia). */
    promotionReview?: boolean;
    /**
     * Solo las ventas offline con esta marca de revisión (SPEC 52): faltante de
     * stock, catálogo inactivo o turno ya cerrado. Filtro en memoria sobre la
     * ventana de fechas, como `promotionReview` con turno.
     */
    review?: SaleReviewKind;
    /** Solo las de esta forma de pago (SPEC 19). */
    paymentMethod?: PaymentMethod;
    page?: number;
    limit?: number;
    /** Cursor opaco de la página anterior (SPEC 08); no aplica con `search` ni en memoria. */
    after?: string;
    /** Quién pregunta. Obligatorio para poder filtrar por turno (ver abajo). */
    requesterId?: string;
    requesterRoleSlug?: string | null;
}): Promise<{ items: Sale[]; meta: ListMeta }> => {
    // Filtrar por turno es leer el turno: si no se comprueba la pertenencia, un
    // cajero reconstruye el corte de otro pasando su `cashSessionId` y se salta
    // el `assertCanAccessSession` de `GET /cash-sessions/:id/summary`.
    if (filters.cashSessionId) {
        const session = await cashSessionsRepo.getCashSessionById(filters.cashSessionId);
        if (!session) {
            throw notFound('Turno de caja');
        }
        assertCanAccessSession(session, filters.requesterId ?? '', filters.requesterRoleSlug);
    }

    const { page, limit } = parsePagination(filters.page, filters.limit);

    // Firestore resuelve la página con cursor (~`limit` lecturas en cualquier
    // profundidad, SPEC 08) salvo con búsqueda de texto, o si piden forma de pago o
    // revisión en una combinación sin índice (turno o anuladas incluidas): ahí el
    // filtro corre en memoria sobre la ventana. Con ellos en la consulta (SPEC 19)
    // el `total` es exacto y hay `nextCursor`.
    const wantsFieldFilter = Boolean(filters.paymentMethod || filters.promotionReview);
    const inQuery = Object.keys(
        salesRepo.serverSideFilters({
            cashSessionId: filters.cashSessionId,
            includeVoided: filters.includeVoided,
            paymentMethod: filters.paymentMethod,
            promotionReview: filters.promotionReview,
        }),
    ).length > 0;

    // La marca de revisión (SPEC 52) siempre corre en memoria: son pocas ventas y
    // la ventana tiene fecha, no vale un índice por marca.
    if (!filters.search && !filters.review && (!wantsFieldFilter || inQuery)) {
        const result = await salesRepo.listSalesPage({
            from: filters.from,
            to: filters.to,
            cashSessionId: filters.cashSessionId,
            includeVoided: filters.includeVoided,
            paymentMethod: filters.paymentMethod,
            promotionReview: filters.promotionReview,
            page,
            limit,
            after: filters.after,
        });
        return {
            items: result.items,
            meta: buildListMeta(page, limit, result.total, result.nextCursor),
        };
    }

    const { items: sales } = await salesRepo.listSales({
        from: filters.from,
        to: filters.to,
        cashSessionId: filters.cashSessionId,
        includeVoided: filters.includeVoided,
        // Con búsqueda de texto o el filtro de revisión, el filtro corre en
        // memoria y necesita ver toda la ventana; sin ellos basta traer hasta la
        // profundidad de página pedida. Son pocas y la ventana tiene fecha, así
        // que no vale un índice `[promotionReview, createdAt]`.
        maxDocs: undefined,
    });

    let filtered = sales;

    if (filters.promotionReview) {
        filtered = filtered.filter((sale) => sale.promotionReview === true);
    }

    if (filters.review) {
        filtered = filtered.filter(SALE_REVIEW_FILTERS[filters.review]);
    }

    if (filters.paymentMethod) {
        filtered = filtered.filter((sale) => sale.paymentMethod === filters.paymentMethod);
    }

    if (filters.search) {
        const term = filters.search.toLowerCase();
        filtered = filtered.filter((sale) =>
            sale.folio.toLowerCase().includes(term) ||
            sale.items.some((item) => saleItemName(item).toLowerCase().includes(term)),
        );
    }

    // Sin búsqueda, `filtered.length` es solo lo leído hasta `page * limit` (no
    // el total real de la ventana): correcto para `items`, pero `meta.total`
    // subestima si hay más páginas atrás sin pedir.
    const paginated = paginate(filtered, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

/** Anulación de ventas: solo el rol de sistema `admin` (no un área de permiso). */
/**
 * Refresca la foto del cobro Point de la venta a partir del aviso de Mercado
 * Pago. La venta ya está registrada y no se toca: lo que cambia es el estado del
 * cobro del otro lado (reembolso, cancelación, contracargo), y sin esto la venta
 * seguiría diciendo `processed` para siempre.
 *
 * Devuelve `null` si la orden no corresponde a ninguna venta —puede ser de un
 * cobro directo, o de un cobro aprobado cuya venta nunca se registró (esa
 * huérfana se reporta en el log: es justo lo que busca la conciliación diaria).
 */
export const syncPointPaymentFromOrder = async (orderId: string): Promise<Sale | null> => {
    const sale = await salesRepo.findSaleByPointOrderId(orderId);
    if (!sale) {
        return null;
    }

    const order = await mercadoPagoService.getOrder(orderId);
    if (sale.pointPayment?.status === order.status) {
        return sale;
    }

    const pointPayment: PointPaymentSnapshot = {
        orderId: order.id,
        paymentId: order.paymentId,
        status: order.status,
        amount: order.amount,
        terminalId: order.terminalId,
        externalReference: order.externalReference,
    };
    await salesRepo.updateSalePointPayment(sale.id, pointPayment);

    if (order.status !== 'processed') {
        // El dinero de una venta cobrada dejó de estar: no se anula sola (eso
        // devolvería stock sin decisión de nadie), pero tiene que verse.
        console.warn('El cobro Point de una venta cambió de estado en Mercado Pago', {
            saleId: sale.id,
            folio: sale.folio,
            orderId,
            status: order.status,
        });
    }

    return { ...sale, pointPayment };
};

/**
 * Anular es **operación normal de mostrador**: el cajero se equivoca de producto
 * o el cliente se arrepiente, y eso pasa con la fila enfrente. Exigir un admin
 * obligaba a escalar cada error y empujaba a la práctica peor —dejar la venta
 * mal registrada y "arreglarla" a mano en el corte—, que es justo lo que un
 * rastro auditable debe evitar.
 *
 * Basta `pos:write` —el permiso con el que se cobra— o `sales:write`.
 *
 * `sales:write` se había reservado para anular, devolver y reembolsar, fuera
 * del mostrador, por un motivo real: un cajero que anula sus propias ventas
 * puede quedarse el efectivo. Pero negarlo no elimina ese riesgo, solo empuja a
 * la salida peor —dejar la venta mal registrada y cuadrar el corte a mano—, que
 * además no deja rastro. Aquí el control compensatorio es la firma: `voidedAt`,
 * `voidedBy`, el renglón de anulación y el contra-asiento del libro de control.
 *
 * **Devolver y reembolsar siguen en `sales:write`**: ahí sí sale dinero de la
 * caja hacia el cliente, y eso no es rutina de mostrador.
 *
 * La otra excepción está en `voidSale`: tocar una venta de un turno **ya
 * cerrado** cambia un arqueo firmado, y eso sigue siendo de admin.
 */
export const assertCanVoidSale = (user: {
    role: { slug: string };
    permissions: RolePermission[];
}): void => {
    const puede =
        hasPermission(user.permissions, 'pos', 'write', user.role.slug) ||
        hasPermission(user.permissions, 'sales', 'write', user.role.slug);
    if (!puede) {
        throw forbidden('Tu rol no tiene permiso para anular ventas', 'VOID_FORBIDDEN');
    }
};
