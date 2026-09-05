import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
    getMercadoPagoAccessToken,
    getMercadoPagoUserId,
    getMercadoPagoWebhookSecret,
    getPointPrintOnTerminal,
    isProduction,
} from '../config/env';
import {
    PointDevice,
    PointOperatingMode,
    PointOrder,
    PointOrderStatus,
    PointPos,
    PointStore,
} from '../types';
import { AppError, badRequest, unauthorized } from '../utils/errors';

const MP_BASE_URL = 'https://api.mercadopago.com';

/**
 * Corte de la llamada a Mercado Pago. Sin él, una API colgada mantiene viva la
 * Function hasta su propio timeout y la caja se queda girando con el cliente
 * enfrente; 15 s es holgado para `POST /v1/orders`, que solo encola la orden.
 */
const MP_TIMEOUT_MS = 15_000;

/**
 * Vida de la orden en la terminal. Mercado Pago usa 15 minutos por defecto; se
 * fija explícito para que el valor sea una decisión del POS y no un default que
 * pueda cambiar del otro lado.
 */
const POINT_ORDER_EXPIRATION = 'PT15M';

/**
 * Espera entre reintentos de las consultas (`GET`). Corta a propósito: al otro
 * lado del mostrador hay un cliente esperando, y el POS sigue sondeando.
 */
const MP_RETRY_DELAYS_MS = [150, 400];

interface MpTerminal {
  id: string;
  pos_id?: string | number | null;
  store_id?: string | number | null;
  external_pos_id?: string | null;
  operating_mode: string;
}

interface MpOrderResponse {
  id: string;
  status: PointOrderStatus;
  status_detail?: string | null;
  external_reference: string;
  total_amount?: string;
  total_paid_amount?: string;
  config?: { point?: { terminal_id?: string } };
  transactions?: { payments?: Array<{ id: string; amount: string }> };
}

interface MpStoreResponse {
  id: number | string;
  name: string;
  external_id?: string | null;
}

interface MpPosResponse {
  id: number | string;
  name: string;
  store_id: number | string;
  external_id?: string | null;
  external_store_id?: string | null;
  status?: string | null;
}

const extractMpMessage = (body: unknown): string => {
    if (!body || typeof body !== 'object') {
        return 'Error al comunicarse con Mercado Pago';
    }
    const data = body as {
    message?: string;
    error?: string;
    cause?: Array<{ description?: string; message?: string }>;
  };
    const cause = data.cause?.[0]?.description ?? data.cause?.[0]?.message;
    return (
        cause ??
    data.message ??
    data.error ??
    'Error al comunicarse con Mercado Pago'
    );
};

const mpRequest = async <T>(
    path: string,
    init: {
    method: string;
    body?: unknown;
    idempotent?: boolean;
    /**
     * Llave estable de idempotencia. Sin ella se genera un uuid nuevo por
     * llamada, así que un retry SÍ vuelve a cobrar/reembolsar: pásala siempre
     * que la operación mueva dinero y pueda reintentarse.
     */
    idempotencyKey?: string;
  },
): Promise<T> => {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${getMercadoPagoAccessToken()}`,
        'Content-Type': 'application/json',
    };
    if (init.idempotent) {
        headers['X-Idempotency-Key'] = init.idempotencyKey ?? randomUUID();
    }

    /**
   * Solo se reintenta lo que no mueve dinero al repetirse: los `GET` (consultar
   * orden, pago, terminales) son idempotentes por definición. Un `POST` que
   * expiró por timeout puede haber llegado igual, así que reintentarlo es
   * exactamente lo que duplicaría un cobro.
   */
    const retryable = init.method === 'GET';
    const attempts = retryable ? MP_RETRY_DELAYS_MS.length + 1 : 1;
    let lastError: AppError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
            await sleep(MP_RETRY_DELAYS_MS[attempt - 1]);
        }

        let response: Response;
        try {
            response = await fetch(`${MP_BASE_URL}${path}`, {
                method: init.method,
                headers,
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
                signal: AbortSignal.timeout(MP_TIMEOUT_MS),
            });
        } catch (error) {
            // Timeout o red caída: es reintentable, y el POS debe poder distinguirlo de
            // un rechazo de la terminal para no dar el cobro por perdido.
            lastError = new AppError(
                504,
                'MERCADOPAGO_UNAVAILABLE',
                error instanceof Error && error.name === 'TimeoutError'
                    ? 'Mercado Pago no respondió a tiempo. Verifica el estado ' +
                      'del cobro antes de reintentar.'
                    : 'No se pudo comunicar con Mercado Pago',
            );
            continue;
        }

        const body = await response.json().catch(() => null);

        if (response.ok) {
            return body as T;
        }

        const error = toMpError(response.status, body);
        // 4xx que no es rate limit: la respuesta no va a cambiar por insistir.
        if (response.status < 500 && response.status !== 429) {
            throw error;
        }
        lastError = error;
    }

    throw lastError ??
    new AppError(502, 'MERCADOPAGO_UNAVAILABLE', 'Mercado Pago no está disponible');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Traduce el error de Mercado Pago conservando su significado. Devolver 400 para
 * todo hacía que un token vencido o una caída de su API se leyeran en caja como
 * "datos inválidos", y el cajero reintentaba corrigiendo lo que no estaba mal.
 */
const toMpError = (status: number, body: unknown): AppError => {
    const message = extractMpMessage(body);
    if (status === 401 || status === 403) {
        return new AppError(
            502,
            'MERCADOPAGO_AUTH',
            `Mercado Pago rechazó las credenciales del comercio: ${message}`,
        );
    }
    if (status === 404) {
        return new AppError(404, 'NOT_FOUND', message);
    }
    if (status === 429) {
        return new AppError(
            429,
            'MERCADOPAGO_RATE_LIMIT',
            `Mercado Pago está limitando las peticiones: ${message}`,
        );
    }
    if (status >= 500) {
        return new AppError(
            502,
            'MERCADOPAGO_UNAVAILABLE',
            `Mercado Pago no está disponible: ${message}`,
        );
    }
    return badRequest(message);
};

const mapDevice = (terminal: MpTerminal): PointDevice => ({
    id: terminal.id,
    posId: terminal.pos_id == null ? null : String(terminal.pos_id),
    storeId: terminal.store_id == null ? null : String(terminal.store_id),
    externalPosId: terminal.external_pos_id ?? null,
    operatingMode: terminal.operating_mode,
});

const mapOrder = (order: MpOrderResponse, amount?: string): PointOrder => ({
    id: order.id,
    status: order.status,
    statusDetail: order.status_detail ?? null,
    terminalId: order.config?.point?.terminal_id ?? '',
    amount:
    amount ??
    order.total_paid_amount ??
    order.total_amount ??
    order.transactions?.payments?.[0]?.amount ??
    '0.00',
    externalReference: order.external_reference,
    paymentId: order.transactions?.payments?.[0]?.id ?? null,
});

interface MpTerminalsResponse {
  data?: { terminals?: MpTerminal[] };
  terminals?: MpTerminal[];
}

export const listDevices = async (filters?: {
  storeId?: string;
  posId?: string;
}): Promise<PointDevice[]> => {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    if (filters?.storeId) {
        params.set('store_id', filters.storeId);
    }
    if (filters?.posId) {
        params.set('pos_id', filters.posId);
    }
    const response = await mpRequest<MpTerminalsResponse>(
        `/terminals/v1/list?${params.toString()}`,
        { method: 'GET' },
    );
    const terminals = response.data?.terminals ?? response.terminals ?? [];
    return terminals.map(mapDevice);
};

export const setupDeviceOperatingMode = async (input: {
  deviceId: string;
  operatingMode: Exclude<PointOperatingMode, 'UNDEFINED'>;
}): Promise<PointDevice> => {
    const response = await mpRequest<{ terminals?: MpTerminal[] }>(
        '/terminals/v1/setup',
        {
            method: 'PATCH',
            body: {
                terminals: [
                    {
                        id: input.deviceId,
                        operating_mode: input.operatingMode,
                    },
                ],
            },
        },
    );
    const terminal = response.terminals?.[0];
    if (!terminal) {
        throw badRequest('Mercado Pago no devolvió la terminal actualizada');
    }
    return mapDevice(terminal);
};

export const createStore = async (input: {
  name: string;
  externalId?: string;
  streetName: string;
  streetNumber: string;
  cityName: string;
  stateName: string;
  latitude: number;
  longitude: number;
  reference?: string;
}): Promise<PointStore> => {
    const userId = getMercadoPagoUserId();
    const store = await mpRequest<MpStoreResponse>(`/users/${userId}/stores`, {
        method: 'POST',
        body: {
            name: input.name,
            external_id: input.externalId,
            location: {
                street_name: input.streetName,
                street_number: input.streetNumber,
                city_name: input.cityName,
                state_name: input.stateName,
                latitude: input.latitude,
                longitude: input.longitude,
                reference: input.reference,
            },
        },
    });
    return {
        id: String(store.id),
        name: store.name,
        externalId: store.external_id ?? null,
    };
};

export const createPos = async (input: {
  name: string;
  storeId: string | number;
  externalId: string;
  externalStoreId?: string;
  category?: number;
}): Promise<PointPos> => {
    const pos = await mpRequest<MpPosResponse>('/pos', {
        method: 'POST',
        body: {
            name: input.name,
            store_id: Number(input.storeId),
            external_id: input.externalId,
            external_store_id: input.externalStoreId,
            category: input.category,
        },
    });
    return {
        id: String(pos.id),
        name: pos.name,
        storeId: String(pos.store_id),
        externalId: pos.external_id ?? null,
        externalStoreId: pos.external_store_id ?? null,
        status: pos.status ?? null,
    };
};

export const createOrder = async (input: {
  deviceId: string;
  amount: number;
  externalReference: string;
  description?: string;
  expirationTime?: string;
  printOnTerminal?: 'no_ticket' | 'seller_ticket' | 'buyer_ticket';
  idempotencyKey?: string;
}): Promise<PointOrder> => {
    const amount = input.amount.toFixed(2);
    const pointConfig: Record<string, string> = {
        terminal_id: input.deviceId,
        print_on_terminal: input.printOnTerminal ?? getPointPrintOnTerminal(),
    };

    const order = await mpRequest<MpOrderResponse>('/v1/orders', {
        method: 'POST',
        idempotent: true,
        idempotencyKey: input.idempotencyKey,
        body: {
            type: 'point',
            external_reference: input.externalReference,
            description: input.description,
            expiration_time: input.expirationTime ?? POINT_ORDER_EXPIRATION,
            transactions: { payments: [{ amount }] },
            config: { point: pointConfig },
        },
    });
    return mapOrder(order, amount);
};

export const getOrder = async (orderId: string): Promise<PointOrder> => {
    const order = await mpRequest<MpOrderResponse>(`/v1/orders/${orderId}`, {
        method: 'GET',
    });
    return mapOrder(order);
};

/**
 * Cancela la orden. Mercado Pago solo lo permite mientras la orden sigue en
 * `created`: una vez que la terminal la tomó (`at_terminal`) la cancelación se
 * hace **en la terminal**, y el POS tiene que decirlo con esas palabras en vez
 * de repetir un error de la API que el cajero no puede accionar.
 */
export const cancelOrder = async (orderId: string): Promise<void> => {
    try {
        await mpRequest(`/v1/orders/${orderId}/cancel`, {
            method: 'POST',
            idempotent: true,
            idempotencyKey: `cancel-${orderId}`,
        });
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 400) {
            throw badRequest(
                `${error.message}. Si la terminal ya tomó el cobro, cancélalo desde la terminal.`,
            );
        }
        throw error;
    }
};

/* ── Checkout Pro: cobro en línea por link de pago ─────────────────────── */

interface MpPreferenceResponse {
  id: string;
  init_point?: string | null;
  sandbox_init_point?: string | null;
  external_reference?: string | null;
  expiration_date_to?: string | null;
}

interface MpPaymentResponse {
  id: number | string;
  status: string;
  status_detail?: string | null;
  transaction_amount?: number;
  external_reference?: string | null;
  date_approved?: string | null;
}

export interface CheckoutPreference {
  id: string;
  initPoint: string;
  sandboxInitPoint: string | null;
  externalReference: string;
  expiresAt: string | null;
}

export interface CheckoutPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  amount: number | null;
  externalReference: string | null;
}

const mapPayment = (payment: MpPaymentResponse): CheckoutPayment => ({
    id: String(payment.id),
    status: payment.status,
    statusDetail: payment.status_detail ?? null,
    amount: payment.transaction_amount ?? null,
    externalReference: payment.external_reference ?? null,
});

/**
 * Crea la preferencia de Checkout Pro (link de pago). Se manda `expires` con una
 * ventana corta: un link vivo para siempre es un cobro que puede ejecutarse
 * cuando el cajero ya lo dio por muerto.
 */
export const createCheckoutPreference = async (input: {
  title: string;
  amount: number;
  externalReference: string;
  expirationMinutes: number;
  notificationUrl?: string | null;
  returnUrl?: string | null;
  idempotencyKey?: string;
}): Promise<CheckoutPreference> => {
    const expiresAt = new Date(
        Date.now() + input.expirationMinutes * 60 * 1000,
    ).toISOString();

    const preference = await mpRequest<MpPreferenceResponse>(
        '/checkout/preferences',
        {
            method: 'POST',
            idempotent: true,
            idempotencyKey: input.idempotencyKey,
            body: {
                items: [
                    {
                        title: input.title,
                        quantity: 1,
                        currency_id: 'MXN',
                        unit_price: input.amount,
                    },
                ],
                external_reference: input.externalReference,
                notification_url: input.notificationUrl ?? undefined,
                back_urls: input.returnUrl
                    ? {
                        success: input.returnUrl,
                        pending: input.returnUrl,
                        failure: input.returnUrl,
                    }
                    : undefined,
                auto_return: input.returnUrl ? 'approved' : undefined,
                binary_mode: true,
                expires: true,
                expiration_date_from: new Date().toISOString(),
                expiration_date_to: expiresAt,
            },
        },
    );

    if (!preference.init_point) {
        throw badRequest('Mercado Pago no devolvió el link de pago');
    }

    return {
        id: preference.id,
        initPoint: preference.init_point,
        sandboxInitPoint: preference.sandbox_init_point ?? null,
        externalReference: preference.external_reference ?? input.externalReference,
        expiresAt: preference.expiration_date_to ?? expiresAt,
    };
};

/**
 * Cierra el link de pago. La preferencia no se borra en Mercado Pago; se vence
 * hacia atrás, que es la forma soportada de dejarla sin efecto.
 */
export const expireCheckoutPreference = async (
    preferenceId: string,
): Promise<void> => {
    const expiredAt = new Date(Date.now() - 60 * 1000).toISOString();
    await mpRequest(`/checkout/preferences/${preferenceId}`, {
        method: 'PUT',
        body: { expires: true, expiration_date_to: expiredAt },
    });
};

export const getPayment = async (
    paymentId: string,
): Promise<CheckoutPayment> => {
    const payment = await mpRequest<MpPaymentResponse>(
        `/v1/payments/${paymentId}`,
        { method: 'GET' },
    );
    return mapPayment(payment);
};

/** Entre varios intentos sobre la misma referencia, el aprobado manda. */
const pickPayment = (payments: CheckoutPayment[]): CheckoutPayment | null => {
    if (!payments.length) {
        return null;
    }
    return payments.find((payment) => payment.status === 'approved') ?? payments[0];
};

interface MpMerchantOrder {
  id: number | string;
  external_reference?: string | null;
  order_status?: string | null;
  payments?: Array<{
    id: number | string;
    status: string;
    status_detail?: string | null;
    transaction_amount?: number;
  }>;
}

const mapMerchantOrderPayments = (order: MpMerchantOrder): CheckoutPayment[] =>
    (order.payments ?? []).map((payment) => ({
        id: String(payment.id),
        status: payment.status,
        statusDetail: payment.status_detail ?? null,
        amount: payment.transaction_amount ?? null,
        externalReference: order.external_reference ?? null,
    }));

/** Pago de una merchant order concreta (aviso `merchant_order` del webhook). */
export const getMerchantOrderPayment = async (
    merchantOrderId: string,
): Promise<CheckoutPayment | null> => {
    const order = await mpRequest<MpMerchantOrder>(
        `/merchant_orders/${merchantOrderId}`,
        { method: 'GET' },
    );
    return pickPayment(mapMerchantOrderPayments(order));
};

/**
 * Pago asociado a la referencia del cobro. Es la forma de resolver un Checkout
 * Pro sin depender del webhook: la caja pregunta mientras espera.
 *
 * Se consulta primero la búsqueda de pagos y, si no devuelve nada, la de
 * merchant orders: la primera tiene consistencia eventual y un pago recién hecho
 * puede no aparecer todavía, mientras que la orden comercial ya existe desde que
 * se creó la preferencia.
 */
export const findPaymentByExternalReference = async (
    externalReference: string,
): Promise<CheckoutPayment | null> => {
    const params = new URLSearchParams({
        external_reference: externalReference,
        sort: 'date_created',
        criteria: 'desc',
        limit: '5',
    });
    const response = await mpRequest<{ results?: MpPaymentResponse[] }>(
        `/v1/payments/search?${params.toString()}`,
        { method: 'GET' },
    );
    const payment = pickPayment((response.results ?? []).map(mapPayment));
    if (payment) {
        return payment;
    }

    return findPaymentByMerchantOrder(externalReference);
};

const findPaymentByMerchantOrder = async (
    externalReference: string,
): Promise<CheckoutPayment | null> => {
    try {
        const params = new URLSearchParams({ external_reference: externalReference });
        const response = await mpRequest<{ elements?: MpMerchantOrder[] }>(
            `/merchant_orders/search?${params.toString()}`,
            { method: 'GET' },
        );
        const payments = (response.elements ?? []).flatMap(mapMerchantOrderPayments);
        return pickPayment(payments);
    } catch (error) {
    // El respaldo nunca debe tumbar la consulta principal: sin pago, el cobro
    // sigue pendiente y la caja vuelve a preguntar.
        console.warn('No se pudo consultar merchant_orders de Mercado Pago', error);
        return null;
    }
};

export const refundOrder = async (input: {
  orderId: string;
  paymentId?: string;
  amount?: number;
  idempotencyKey?: string;
}): Promise<PointOrder> => {
    const body =
    input.paymentId && input.amount !== undefined
        ? {
            transactions: [
                {
                    id: input.paymentId,
                    amount: input.amount.toFixed(2),
                },
            ],
        }
        : undefined;

    const order = await mpRequest<MpOrderResponse>(
        `/v1/orders/${input.orderId}/refund`,
        {
            method: 'POST',
            idempotent: true,
            idempotencyKey: input.idempotencyKey,
            body,
        },
    );
    return mapOrder(order);
};

export const verifyWebhookSignature = (input: {
  xSignature?: string;
  xRequestId?: string;
  dataId?: string;
}): void => {
    const secret = getMercadoPagoWebhookSecret();
    if (!secret) {
    /**
     * Sin secreto, cualquiera que conozca la URL puede publicar un aviso y con
     * eso marcar un cobro como aprobado. En producción se rechaza (el POS sigue
     * resolviendo por sondeo mientras se configura el secreto del panel de
     * Mercado Pago); en desarrollo se acepta para poder simular avisos.
     */
        if (isProduction()) {
            console.error(
                'MERCADOPAGO_WEBHOOK_SECRET no está configurado: se rechazan ' +
                'las notificaciones de Mercado Pago',
            );
            throw unauthorized(
                'El webhook de Mercado Pago no está configurado con su firma secreta',
            );
        }
        console.warn(
            'MERCADOPAGO_WEBHOOK_SECRET no está configurado: las notificaciones ' +
            'se aceptan sin validar firma',
        );
        return;
    }
    if (!input.xSignature) {
        throw unauthorized('Firma de webhook de Mercado Pago inválida');
    }

    const parts = Object.fromEntries(
        input.xSignature.split(',').map((part) => {
            const [key, ...rest] = part.trim().split('=');
            return [key, rest.join('=')];
        }),
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) {
        throw unauthorized('Firma de webhook de Mercado Pago inválida');
    }

    const manifestParts: string[] = [];
    if (input.dataId) {
        manifestParts.push(`id:${input.dataId.toLowerCase()}`);
    }
    if (input.xRequestId) {
        manifestParts.push(`request-id:${input.xRequestId}`);
    }
    manifestParts.push(`ts:${ts}`);
    const manifest = `${manifestParts.join(';')};`;

    const expected = createHmac('sha256', secret).update(manifest).digest('hex');
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(v1);
    if (
        expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
        throw unauthorized('Firma de webhook de Mercado Pago inválida');
    }
};

/**
 * Temas con los que Mercado Pago anuncia el avance de una orden Point. Llegan
 * con nombres distintos según la versión del webhook configurado en el panel,
 * y el legado manda `topic` en vez de `type`.
 */
export const isOrderTopic = (type?: string): boolean =>
    !type ||
  type === 'order' ||
  type === 'orders' ||
  type === 'topic_orders' ||
  type === 'point_integration_wh';

export const handleWebhookNotification = async (input: {
  dataId?: string;
  type?: string;
}): Promise<{ received: true; order: PointOrder | null }> => {
    if (!isOrderTopic(input.type) || !input.dataId) {
        return { received: true, order: null };
    }
    const order = await getOrder(input.dataId);
    return { received: true, order };
};
