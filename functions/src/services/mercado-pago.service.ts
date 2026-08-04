import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
    getMercadoPagoAccessToken,
    getMercadoPagoUserId,
    getMercadoPagoWebhookSecret,
} from '../config/env';
import {
    PointDevice,
    PointOperatingMode,
    PointOrder,
    PointOrderStatus,
    PointPos,
    PointStore,
} from '../types';
import { badRequest, unauthorized } from '../utils/errors';

const MP_BASE_URL = 'https://api.mercadopago.com';

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
    return cause ?? data.message ?? data.error ?? 'Error al comunicarse con Mercado Pago';
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

    const response = await fetch(`${MP_BASE_URL}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
        throw badRequest(extractMpMessage(body));
    }

    return body as T;
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
    amount: amount
        ?? order.total_paid_amount
        ?? order.total_amount
        ?? order.transactions?.payments?.[0]?.amount
        ?? '0.00',
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
    const response = await mpRequest<{ terminals?: MpTerminal[] }>('/terminals/v1/setup', {
        method: 'PATCH',
        body: {
            terminals: [{
                id: input.deviceId,
                operating_mode: input.operatingMode,
            }],
        },
    });
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
}): Promise<PointOrder> => {
    const amount = input.amount.toFixed(2);
    const pointConfig: Record<string, string> = { terminal_id: input.deviceId };
    if (input.printOnTerminal) {
        pointConfig.print_on_terminal = input.printOnTerminal;
    }

    const order = await mpRequest<MpOrderResponse>('/v1/orders', {
        method: 'POST',
        idempotent: true,
        body: {
            type: 'point',
            external_reference: input.externalReference,
            description: input.description,
            expiration_time: input.expirationTime,
            transactions: { payments: [{ amount }] },
            config: { point: pointConfig },
        },
    });
    return mapOrder(order, amount);
};

export const getOrder = async (orderId: string): Promise<PointOrder> => {
    const order = await mpRequest<MpOrderResponse>(`/v1/orders/${orderId}`, { method: 'GET' });
    return mapOrder(order);
};

export const cancelOrder = async (orderId: string): Promise<void> => {
    await mpRequest(`/v1/orders/${orderId}/cancel`, { method: 'POST', idempotent: true });
};

export const refundOrder = async (input: {
    orderId: string;
    paymentId?: string;
    amount?: number;
    idempotencyKey?: string;
}): Promise<PointOrder> => {
    const body = input.paymentId && input.amount !== undefined
        ? {
            transactions: [{
                id: input.paymentId,
                amount: input.amount.toFixed(2),
            }],
        }
        : undefined;

    const order = await mpRequest<MpOrderResponse>(`/v1/orders/${input.orderId}/refund`, {
        method: 'POST',
        idempotent: true,
        idempotencyKey: input.idempotencyKey,
        body,
    });
    return mapOrder(order);
};

export const verifyWebhookSignature = (input: {
    xSignature?: string;
    xRequestId?: string;
    dataId?: string;
}): void => {
    const secret = getMercadoPagoWebhookSecret();
    if (!secret) {
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
        expectedBuffer.length !== providedBuffer.length
        || !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
        throw unauthorized('Firma de webhook de Mercado Pago inválida');
    }
};

export const handleWebhookNotification = async (input: {
    dataId?: string;
    type?: string;
}): Promise<{ received: true; order: PointOrder | null }> => {
    const isOrder = !input.type || input.type === 'order' || input.type === 'topic_orders';
    if (!isOrder || !input.dataId) {
        return { received: true, order: null };
    }
    const order = await getOrder(input.dataId);
    return { received: true, order };
};
