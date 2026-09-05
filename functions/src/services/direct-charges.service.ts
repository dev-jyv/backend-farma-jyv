import {
    DirectCharge,
    DirectChargeChannel,
    DirectChargeStatus,
    PointOrder,
    PointOrderStatus,
} from '../types';
import { getCheckoutReturnUrl, getPublicApiUrl } from '../config/env';
import { badRequest, conflict, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import { db, now } from '../utils/firestore';
import * as directChargesRepo from '../repositories/direct-charges.repository';
import * as mercadoPagoService from './mercado-pago.service';
import { recordAudit } from './audit.service';

/**
 * Cobro directo: dinero que entra por Mercado Pago **sin** una venta detrás
 * (servicios, abonos, cobros a terceros), por terminal Point o por link de pago
 * (Checkout Pro). Vive en `directCharges` y no toca `sales`, ni el inventario,
 * ni el arqueo de efectivo: por diseño no aparece en ningún reporte de ventas.
 */

const IDEMPOTENCY_COLLECTION = 'directChargeIdempotencyKeys';
/** Ventana de reintento cubierta por la llave; después el TTL de Firestore la borra. */
const IDEMPOTENCY_TTL_HOURS = 48;
/** Vida del link de pago. Corto a propósito: un link viejo es un cobro sorpresa. */
const ONLINE_EXPIRATION_MINUTES = 30;

/** La llave se guarda por cajero: los uuid los genera el cliente y no son de confianza. */
const buildIdempotencyDocId = (cashierId: string, key: string): string => `${cashierId}:${key}`;

/**
 * Estados de la order Point que aún pueden cambiar. Mientras la order esté aquí
 * el cobro sigue `pending` y la caja sigue consultando.
 */
const PENDING_ORDER_STATUSES: PointOrderStatus[] = ['created', 'at_terminal', 'action_required'];

/**
 * Estado del cobro a partir del de la order. `refunded` cuenta como `canceled`:
 * el dinero regresó, y para la caja el cobro dejó de existir.
 */
const toChargeStatus = (orderStatus: PointOrderStatus): DirectChargeStatus => {
    if (orderStatus === 'processed') {
        return 'approved';
    }
    if (orderStatus === 'canceled' || orderStatus === 'refunded') {
        return 'canceled';
    }
    if (PENDING_ORDER_STATUSES.includes(orderStatus)) {
        return 'pending';
    }
    return 'failed';
};

/**
 * Estado del cobro a partir del `status` del pago de Checkout Pro. `authorized`
 * NO es cobrado: el dinero está retenido hasta la captura, así que sigue pendiente.
 */
const toChargeStatusFromPayment = (paymentStatus: string): DirectChargeStatus => {
    if (paymentStatus === 'approved') {
        return 'approved';
    }
    if (paymentStatus === 'rejected') {
        return 'failed';
    }
    const isReverted = paymentStatus === 'cancelled' ||
        paymentStatus === 'refunded' ||
        paymentStatus === 'charged_back';
    if (isReverted) {
        return 'canceled';
    }
    return 'pending';
};

/**
 * Transiciones que un aviso de Mercado Pago puede aplicar sobre un cobro ya
 * resuelto.
 *
 * Los avisos llegan repetidos y **fuera de orden** (Mercado Pago reenvía cada
 * uno hasta recibir un 200, y una preferencia puede acumular varios intentos de
 * pago). Sin esta tabla, el aviso de un intento rechazado que llega después del
 * aprobado marcaba `failed` un cobro que sí entró, y un aviso viejo con el pago
 * todavía `in_process` devolvía a `pending` un cobro ya aprobado.
 *
 * La regla es que el dinero solo avanza: un cobro aprobado únicamente puede
 * revertirse (reembolso/contracargo → `canceled`), y un cobro cancelado no
 * vuelve de la muerte.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<DirectChargeStatus, DirectChargeStatus[]> = {
    pending: ['pending', 'approved', 'failed', 'canceled'],
    approved: ['approved', 'canceled'],
    // Un rechazo no es definitivo: el mismo link admite otro intento que sí pase.
    failed: ['failed', 'approved', 'canceled'],
    canceled: ['canceled'],
};

const canTransition = (from: DirectChargeStatus, to: DirectChargeStatus): boolean =>
    ALLOWED_STATUS_TRANSITIONS[from].includes(to);

/**
 * Candado de monto en el servicio, no solo en el schema. El schema cubre lo que
 * entra por HTTP; esto cubre a cualquier otro llamador y evita mandar a la
 * terminal un monto que no se puede cobrar.
 */
const assertChargeableAmount = (amount: number): void => {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw badRequest('El monto del cobro debe ser mayor a cero');
    }
};

const toSnapshot = (order: PointOrder): NonNullable<DirectCharge['point']> => ({
    orderId: order.id,
    paymentId: order.paymentId,
    status: order.status,
    amount: order.amount,
    terminalId: order.terminalId,
    externalReference: order.externalReference,
});

export const listDirectCharges = async (filters: {
    from?: string;
    to?: string;
    channel?: DirectChargeChannel;
    status?: DirectChargeStatus;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: DirectCharge[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await directChargesRepo.listDirectCharges({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getDirectCharge = async (id: string): Promise<DirectCharge> => {
    const charge = await directChargesRepo.getDirectChargeById(id);
    if (!charge) {
        throw notFound('Cobro directo');
    }
    return charge;
};

/**
 * Reserva la llave de idempotencia **antes** de tocar Mercado Pago. Devuelve el
 * cobro anterior si la llave ya se usó: un retry nunca vuelve a cobrar.
 */
const reserveIdempotencyKey = async (
    cashierId: string,
    key: string | undefined,
    amount: number,
    channel: DirectChargeChannel,
): Promise<
    | { ref: FirebaseFirestore.DocumentReference | null; existing: null }
    | { ref: null; existing: DirectCharge }
> => {
    if (!key) {
        return { ref: null, existing: null };
    }

    const ref = db().collection(IDEMPOTENCY_COLLECTION).doc(buildIdempotencyDocId(cashierId, key));
    const timestamp = now();
    try {
        await ref.create({
            cashierId,
            amount,
            channel,
            chargeId: null,
            createdAt: timestamp,
            expiresAt: new Date(timestamp.toMillis() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000),
        });
        return { ref, existing: null };
    } catch {
        const reserved = await ref.get();
        const reservedData = reserved.data();

        /**
         * La misma llave con otro monto u otro canal no es un reintento: es un
         * cobro distinto que el POS etiquetó mal. Antes se devolvía el cobro
         * anterior, así que pedir 900 con la llave de un cobro de 90 contestaba
         * 201 con el de 90 —el cajero veía un cobro exitoso por el monto
         * equivocado— y pedirlo en `/online` devolvía un cobro de terminal, sin
         * `initPoint` que compartir.
         */
        const reservedAmount = reservedData?.amount as number | undefined;
        const reservedChannel = reservedData?.channel as DirectChargeChannel | undefined;
        const mismatch = (reservedAmount !== undefined && reservedAmount !== amount) ||
            (reservedChannel !== undefined && reservedChannel !== channel);
        if (mismatch) {
            throw conflict('La llave de idempotencia ya se usó para un cobro distinto');
        }

        const chargeId = reservedData?.chargeId as string | null | undefined;
        if (!chargeId) {
            // Reserva viva sin cobro: el envío anterior sigue en vuelo.
            throw conflict('El cobro ya se está registrando en Mercado Pago');
        }
        const charge = await directChargesRepo.getDirectChargeById(chargeId);
        if (!charge) {
            throw notFound('Cobro directo');
        }
        return { ref: null, existing: charge };
    }
};

/**
 * Manda el cobro a la terminal y lo registra en `pending`. El documento se crea
 * **después** de que Mercado Pago acepta la order: un cobro sin order sería un
 * registro que la caja no puede resolver ni cancelar.
 */
export const createDirectCharge = async (input: {
    deviceId: string;
    amount: number;
    concept: string;
    idempotencyKey?: string;
    cashierId: string;
    roleSlug?: string | null;
}): Promise<DirectCharge> => {
    const concept = input.concept.trim();
    if (!concept) {
        throw badRequest('El concepto del cobro es requerido');
    }
    assertChargeableAmount(input.amount);

    const reservation = await reserveIdempotencyKey(
        input.cashierId,
        input.idempotencyKey,
        input.amount,
        'point',
    );
    if (reservation.existing) {
        return reservation.existing;
    }
    const idempotencyRef = reservation.ref;

    let order: PointOrder;
    try {
        order = await mercadoPagoService.createOrder({
            deviceId: input.deviceId,
            amount: input.amount,
            // La referencia se ata al cobro, no al reloj, y se manda tal cual a la
            // terminal para poder rastrear la order desde el panel de Mercado Pago.
            externalReference: `dc-${input.idempotencyKey ?? Date.now()}`,
            description: concept.slice(0, 150),
            idempotencyKey: input.idempotencyKey,
        });
    } catch (error) {
        // Mercado Pago rechazó la order: se libera la llave para que el cajero
        // reintente sin esperar el TTL.
        await idempotencyRef?.delete().catch(() => undefined);
        throw error;
    }

    const status = toChargeStatus(order.status);
    const timestamp = now();
    const charge = await directChargesRepo.createDirectCharge({
        amount: input.amount,
        concept,
        channel: 'point',
        status,
        statusDetail: order.statusDetail,
        point: toSnapshot(order),
        online: null,
        cashierId: input.cashierId,
        roleSlug: input.roleSlug ?? null,
        canceledBy: null,
        canceledAt: null,
        approvedAt: status === 'approved' ? timestamp : null,
    });

    await idempotencyRef?.update({ chargeId: charge.id }).catch(() => undefined);

    await recordAudit({
        action: 'directCharge.created',
        entity: 'directCharge',
        entityId: charge.id,
        summary: `Cobro directo ${charge.folio} por ${charge.amount.toFixed(2)} — ${concept}`,
        userId: input.cashierId,
        roleSlug: input.roleSlug ?? null,
        metadata: { channel: 'point', orderId: order.id, deviceId: input.deviceId },
    });

    return charge;
};

/**
 * Crea el link de pago (Checkout Pro) y registra el cobro en `pending`. El link
 * vence en `ONLINE_EXPIRATION_MINUTES`; el cobro se resuelve consultando el pago
 * por su `external_reference` (o por webhook, si está configurado).
 */
export const createOnlineDirectCharge = async (input: {
    amount: number;
    concept: string;
    idempotencyKey?: string;
    cashierId: string;
    roleSlug?: string | null;
}): Promise<DirectCharge> => {
    const concept = input.concept.trim();
    if (!concept) {
        throw badRequest('El concepto del cobro es requerido');
    }

    assertChargeableAmount(input.amount);

    const reservation = await reserveIdempotencyKey(
        input.cashierId,
        input.idempotencyKey,
        input.amount,
        'online',
    );
    if (reservation.existing) {
        return reservation.existing;
    }
    const idempotencyRef = reservation.ref;

    const externalReference = `dco-${input.idempotencyKey ?? Date.now()}`;
    const apiUrl = getPublicApiUrl();

    let preference: Awaited<ReturnType<typeof mercadoPagoService.createCheckoutPreference>>;
    try {
        preference = await mercadoPagoService.createCheckoutPreference({
            title: concept.slice(0, 150),
            amount: input.amount,
            externalReference,
            expirationMinutes: ONLINE_EXPIRATION_MINUTES,
            notificationUrl: apiUrl ? `${apiUrl}/payments/mercadopago/webhooks` : null,
            returnUrl: getCheckoutReturnUrl(),
            idempotencyKey: input.idempotencyKey,
        });
    } catch (error) {
        await idempotencyRef?.delete().catch(() => undefined);
        throw error;
    }

    const charge = await directChargesRepo.createDirectCharge({
        amount: input.amount,
        concept,
        channel: 'online',
        status: 'pending',
        statusDetail: null,
        point: null,
        online: {
            preferenceId: preference.id,
            initPoint: preference.initPoint,
            sandboxInitPoint: preference.sandboxInitPoint,
            paymentId: null,
            paymentStatus: null,
            externalReference: preference.externalReference,
            expiresAt: preference.expiresAt,
        },
        cashierId: input.cashierId,
        roleSlug: input.roleSlug ?? null,
        canceledBy: null,
        canceledAt: null,
        approvedAt: null,
    });

    await idempotencyRef?.update({ chargeId: charge.id }).catch(() => undefined);

    await recordAudit({
        action: 'directCharge.created',
        entity: 'directCharge',
        entityId: charge.id,
        summary: `Cobro directo en línea ${charge.folio} por ` +
            `${charge.amount.toFixed(2)} — ${concept}`,
        userId: input.cashierId,
        roleSlug: input.roleSlug ?? null,
        metadata: { channel: 'online', preferenceId: preference.id, externalReference },
    });

    return charge;
};

/** Aplica el estado del pago de Checkout Pro al cobro y lo persiste. */
const applyPayment = async (
    charge: DirectCharge,
    payment: mercadoPagoService.CheckoutPayment,
): Promise<DirectCharge> => {
    const status = toChargeStatusFromPayment(payment.status);
    // Aviso repetido o fuera de orden: no puede degradar un cobro ya resuelto.
    if (!canTransition(charge.status, status)) {
        return charge;
    }
    const online = charge.online
        ? {
            ...charge.online,
            paymentId: payment.id,
            paymentStatus: payment.status,
        }
        : null;

    if (status === charge.status && charge.online?.paymentId === payment.id) {
        return charge;
    }

    return directChargesRepo.updateDirectCharge(charge.id, {
        status,
        statusDetail: payment.statusDetail,
        online,
        approvedAt: status === 'approved' ? (charge.approvedAt ?? now()) : charge.approvedAt,
    });
};

/**
 * Consulta a Mercado Pago y persiste el estado. Es lo que llama el POS mientras
 * espera: la terminal no notifica al cliente, y el webhook puede no estar
 * configurado en todos los ambientes.
 */
export const syncDirectCharge = async (id: string): Promise<DirectCharge> => {
    const charge = await getDirectCharge(id);
    if (charge.status !== 'pending') {
        return charge;
    }

    if (charge.channel === 'online') {
        if (!charge.online) {
            return charge;
        }
        const payment = await mercadoPagoService.findPaymentByExternalReference(
            charge.online.externalReference,
        );
        if (!payment) {
            // Sin pago todavía: si el link ya venció, el cobro no va a llegar.
            const expiresAt = charge.online.expiresAt;
            if (expiresAt && Date.parse(expiresAt) < Date.now()) {
                return directChargesRepo.updateDirectCharge(id, {
                    status: 'failed',
                    statusDetail: 'El link de pago venció sin pagarse',
                });
            }
            return charge;
        }
        return applyPayment(charge, payment);
    }

    if (!charge.point) {
        return charge;
    }
    const order = await mercadoPagoService.getOrder(charge.point.orderId);
    return applyOrder(charge, order);
};

/** Aplica el estado de la order Point al cobro y lo persiste. */
const applyOrder = async (charge: DirectCharge, order: PointOrder): Promise<DirectCharge> => {
    const status = toChargeStatus(order.status);
    // Mismo candado que en los pagos: un aviso de orden atrasado no revive ni
    // degrada un cobro que ya se resolvió.
    if (!canTransition(charge.status, status)) {
        return charge;
    }
    if (status === charge.status && order.status === charge.point?.status) {
        return charge;
    }
    return directChargesRepo.updateDirectCharge(charge.id, {
        status,
        statusDetail: order.statusDetail,
        point: toSnapshot(order),
        approvedAt: status === 'approved' ? (charge.approvedAt ?? now()) : charge.approvedAt,
    });
};

/**
 * Resuelve un cobro con terminal desde el webhook de Mercado Pago. Es lo que
 * cierra el caso que el sondeo no cubre: el cajero cierra la pantalla, o el
 * cobro se cancela **en la terminal** (Mercado Pago no acepta cancelar por API
 * una orden que la terminal ya tomó), y el documento quedaría `pending` para
 * siempre. Devuelve `null` si la orden no es de un cobro directo (p. ej. es de
 * una venta).
 */
export const syncPointChargeFromOrder = async (
    orderId: string,
): Promise<DirectCharge | null> => {
    const charge = await directChargesRepo.findDirectChargeByOrderId(orderId);
    if (!charge) {
        return null;
    }
    if (charge.status !== 'pending') {
        return charge;
    }
    const order = await mercadoPagoService.getOrder(orderId);
    return applyOrder(charge, order);
};

/**
 * Resuelve un cobro en línea desde el webhook de Mercado Pago. Devuelve `null`
 * si el pago no corresponde a un cobro directo (p. ej. es de una venta).
 */
export const syncOnlineChargeFromPayment = async (
    paymentId: string,
): Promise<DirectCharge | null> => {
    const payment = await mercadoPagoService.getPayment(paymentId);
    return applyPaymentToCharge(payment);
};

/**
 * Resuelve el cobro en línea desde el aviso de `merchant_order`. Es la red de
 * seguridad del aviso de `payment`: llega por otro tema y trae los pagos de la
 * orden comercial, así que cubre el caso en que el primero se pierde.
 */
export const syncOnlineChargeFromMerchantOrder = async (
    merchantOrderId: string,
): Promise<DirectCharge | null> => {
    const payment = await mercadoPagoService.getMerchantOrderPayment(merchantOrderId);
    return payment ? applyPaymentToCharge(payment) : null;
};

/** Busca el cobro de esa referencia y le aplica el pago; `null` si no es nuestro. */
const applyPaymentToCharge = async (
    payment: mercadoPagoService.CheckoutPayment,
): Promise<DirectCharge | null> => {
    // El prefijo lo pone `createOnlineDirectCharge`: distingue nuestros cobros de
    // los pagos de una venta o de cualquier otra integración de la misma cuenta.
    if (!payment.externalReference?.startsWith('dco-')) {
        return null;
    }
    const charge = await directChargesRepo.findDirectChargeByExternalReference(
        payment.externalReference,
    );
    if (!charge) {
        return null;
    }
    return applyPayment(charge, payment);
};

/**
 * Cancela un cobro que Mercado Pago aún no aprobó: cancela la order en la
 * terminal o vence el link de pago. Un cobro aprobado NO se cancela aquí: ese
 * dinero ya se cobró y devolverlo es un reembolso explícito
 * (`POST /payments/mercadopago/orders/:id/refund`).
 */
export const cancelDirectCharge = async (
    id: string,
    actor: { userId: string; roleSlug?: string | null },
): Promise<DirectCharge> => {
    /**
     * Se re-consulta el estado en Mercado Pago **antes** de cancelar, en vez de
     * creer al documento local.
     *
     * El documento se queda en `pending` hasta que alguien lo sincroniza (el
     * sondeo del POS o el webhook), así que un cobro ya aprobado que la caja
     * todavía no había visto —el cajero cerró la pantalla, o el aviso no llegó—
     * se cancelaba aquí sin objeción: en el canal en línea `expireCheckoutPreference`
     * vence la preferencia sin fallar aunque el pago ya estuviera cobrado, y el
     * cobro quedaba marcado `canceled` con el dinero adentro. Eso es dinero
     * cobrado que desaparece del registro.
     *
     * No agrega un modo de falla nuevo: cancelar un cobro pendiente ya requería
     * hablar con Mercado Pago (`cancelOrder` / `expireCheckoutPreference`).
     */
    const charge = await syncDirectCharge(id);
    if (charge.status === 'approved') {
        throw badRequest('El cobro ya fue aprobado por Mercado Pago; requiere un reembolso');
    }
    if (charge.status === 'canceled') {
        return charge;
    }

    if (charge.status === 'pending') {
        if (charge.channel === 'online' && charge.online) {
            await mercadoPagoService.expireCheckoutPreference(charge.online.preferenceId);
        } else if (charge.point) {
            await mercadoPagoService.cancelOrder(charge.point.orderId);
        }
    }

    const canceled = await directChargesRepo.updateDirectCharge(id, {
        status: 'canceled',
        canceledAt: now(),
        canceledBy: actor.userId,
    });

    await recordAudit({
        action: 'directCharge.canceled',
        entity: 'directCharge',
        entityId: id,
        summary: `Cobro directo ${charge.folio} cancelado por ${charge.amount.toFixed(2)}`,
        userId: actor.userId,
        roleSlug: actor.roleSlug ?? null,
        metadata: {
            channel: charge.channel,
            orderId: charge.point?.orderId ?? null,
            preferenceId: charge.online?.preferenceId ?? null,
        },
    });

    return canceled;
};
