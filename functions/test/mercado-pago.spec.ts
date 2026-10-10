import { createHmac } from 'crypto';

/**
 * Integración con Mercado Pago: firma del webhook, temas que resuelven una orden
 * y traducción de errores de su API. Todo aquí es puro (se sustituye `fetch`), así
 * que no toca Firestore ni la cuenta real.
 */

const ACCESS_TOKEN = 'TEST-token';
const WEBHOOK_SECRET = 'super-secreto';

process.env.MERCADOPAGO_ACCESS_TOKEN = ACCESS_TOKEN;
process.env.MERCADOPAGO_USER_ID = '1234567';
process.env.MERCADOPAGO_WEBHOOK_SECRET = WEBHOOK_SECRET;

// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as mercadoPago from '../src/services/mercado-pago.service';
import { AppError } from '../src/utils/errors';

type FetchArgs = { url: string; init: RequestInit };

const originalFetch = global.fetch;
let lastCall: FetchArgs | null = null;

/** Sustituye `fetch` por una respuesta fija y guarda la petición emitida. */
const mockFetch = (status: number, body: unknown): void => {
    global.fetch = (async (url: string, init: RequestInit) => {
        lastCall = { url: String(url), init };
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
        } as unknown as Response;
    }) as unknown as typeof fetch;
};

const signatureFor = (dataId: string, requestId: string, ts: string): string => {
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');
    return `ts=${ts},v1=${v1}`;
};

afterEach(() => {
    global.fetch = originalFetch;
    lastCall = null;
});

describe('mercado-pago: creación de orden Point', () => {
    it('manda tipo, monto con dos decimales, terminal e idempotencia', async () => {
        mockFetch(201, { id: 'o1', status: 'created', external_reference: 'dc-key' });

        await mercadoPago.createOrder({
            deviceId: 'NEWLAND_N950__X',
            amount: 150.5,
            externalReference: 'dc-key',
            idempotencyKey: 'dc-key',
        });

        const body = JSON.parse(String(lastCall!.init.body));
        expect(lastCall!.url).toContain('/v1/orders');
        expect(body.type).toBe('point');
        expect(body.transactions.payments[0].amount).toBe('150.50');
        expect(body.config.point.terminal_id).toBe('NEWLAND_N950__X');
        // Sin vigencia explícita la orden dependería del default de Mercado Pago.
        expect(body.expiration_time).toBe('PT15M');
        const headers = lastCall!.init.headers as Record<string, string>;
        expect(headers['X-Idempotency-Key']).toBe('dc-key');
    });

    it('por defecto la terminal no imprime: el ticket lo imprime el POS', async () => {
        mockFetch(201, { id: 'o1', status: 'created', external_reference: 'r' });

        await mercadoPago.createOrder({ deviceId: 'D1', amount: 10, externalReference: 'r' });

        const body = JSON.parse(String(lastCall!.init.body));
        expect(body.config.point.print_on_terminal).toBe('no_ticket');
    });
});

describe('mercado-pago: traducción de errores', () => {
    const expectAppError = async (
        status: number,
        body: unknown,
        expected: { statusCode: number; code: string },
    ): Promise<void> => {
        mockFetch(status, body);
        await expect(mercadoPago.getOrder('o1')).rejects.toMatchObject(expected);
    };

    it('credenciales rechazadas no son un error del cajero', async () => {
        await expectAppError(401, { message: 'invalid token' }, {
            statusCode: 502,
            code: 'MERCADOPAGO_AUTH',
        });
    });

    it('un 500 de Mercado Pago se reporta como servicio no disponible', async () => {
        await expectAppError(500, { message: 'boom' }, {
            statusCode: 502,
            code: 'MERCADOPAGO_UNAVAILABLE',
        });
    });

    it('el rate limit conserva su código', async () => {
        await expectAppError(429, { message: 'too many' }, {
            statusCode: 429,
            code: 'MERCADOPAGO_RATE_LIMIT',
        });
    });

    it('un 400 conserva la causa que manda Mercado Pago', async () => {
        mockFetch(400, { cause: [{ description: 'Terminal no está en modo PDV' }] });
        await expect(mercadoPago.getOrder('o1')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Terminal no está en modo PDV',
        });
    });

    it('una caída de red se distingue de un rechazo', async () => {
        global.fetch = (async () => {
            throw new Error('network down');
        }) as unknown as typeof fetch;

        await expect(mercadoPago.getOrder('o1')).rejects.toMatchObject({
            statusCode: 504,
            code: 'MERCADOPAGO_UNAVAILABLE',
        });
    });
});

describe('mercado-pago: cancelación de orden', () => {
    it('explica que una orden ya tomada se cancela en la terminal', async () => {
        mockFetch(400, { message: 'Order cannot be canceled' });

        await expect(mercadoPago.cancelOrder('o1')).rejects.toMatchObject({
            statusCode: 400,
        });
        await expect(mercadoPago.cancelOrder('o1')).rejects.toThrow(/desde la terminal/);
    });

    it('un error que no es del cajero se propaga tal cual', async () => {
        mockFetch(500, { message: 'boom' });

        const error = await mercadoPago.cancelOrder('o1').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(502);
    });
});

describe('mercado-pago: reintentos', () => {
    /** Responde `failures` veces con error y luego con éxito. */
    const mockFlakyFetch = (failures: number, status: number): { calls: () => number } => {
        let calls = 0;
        global.fetch = (async () => {
            calls += 1;
            if (calls <= failures) {
                if (status === 0) {
                    throw new Error('network down');
                }
                return {
                    ok: false,
                    status,
                    json: async () => ({ message: 'boom' }),
                } as unknown as Response;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ id: 'o1', status: 'processed', external_reference: 'r' }),
            } as unknown as Response;
        }) as unknown as typeof fetch;
        return { calls: () => calls };
    };

    it('una consulta reintenta tras un 500 pasajero', async () => {
        const spy = mockFlakyFetch(1, 500);

        const order = await mercadoPago.getOrder('o1');

        expect(order.status).toBe('processed');
        expect(spy.calls()).toBe(2);
    });

    it('una consulta reintenta tras una caída de red', async () => {
        const spy = mockFlakyFetch(1, 0);

        await mercadoPago.getOrder('o1');

        expect(spy.calls()).toBe(2);
    });

    it('un 400 no se reintenta: la respuesta no va a cambiar', async () => {
        const spy = mockFlakyFetch(1, 400);

        await expect(mercadoPago.getOrder('o1')).rejects.toMatchObject({ statusCode: 400 });
        expect(spy.calls()).toBe(1);
    });

    it('crear una orden NO se reintenta: repetir el POST es cobrar dos veces', async () => {
        const spy = mockFlakyFetch(1, 500);

        await expect(
            mercadoPago.createOrder({ deviceId: 'D1', amount: 10, externalReference: 'r' }),
        ).rejects.toMatchObject({ code: 'MERCADOPAGO_UNAVAILABLE' });
        expect(spy.calls()).toBe(1);
    });
});

describe('mercado-pago: cobro en línea', () => {
    it('si la búsqueda de pagos no devuelve nada, cae a merchant orders', async () => {
        const urls: string[] = [];
        global.fetch = (async (url: string) => {
            urls.push(String(url));
            const isPayments = String(url).includes('/v1/payments/search');
            return {
                ok: true,
                status: 200,
                json: async () =>
                    isPayments
                        ? { results: [] }
                        : {
                            elements: [
                                {
                                    id: 1,
                                    external_reference: 'dco-key',
                                    payments: [
                                        { id: 9, status: 'rejected', transaction_amount: 80 },
                                        { id: 10, status: 'approved', transaction_amount: 80 },
                                    ],
                                },
                            ],
                        },
            } as unknown as Response;
        }) as unknown as typeof fetch;

        const payment = await mercadoPago.findPaymentByExternalReference('dco-key');

        expect(urls.some((url) => url.includes('/merchant_orders/search'))).toBe(true);
        // Un intento rechazado no debe tapar el aprobado de la misma referencia.
        expect(payment).toMatchObject({ id: '10', status: 'approved' });
    });

    it('un fallo del respaldo deja el cobro pendiente en vez de tumbar la consulta', async () => {
        global.fetch = (async (url: string) => {
            if (String(url).includes('/v1/payments/search')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ results: [] }),
                } as unknown as Response;
            }
            return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch;

        await expect(mercadoPago.findPaymentByExternalReference('dco-key')).resolves.toBeNull();
    });
});

describe('mercado-pago: webhook', () => {
    it('acepta la firma válida', () => {
        const ts = '1704908010';
        expect(() =>
            mercadoPago.verifyWebhookSignature({
                xSignature: signatureFor('ABC123', 'req-1', ts),
                xRequestId: 'req-1',
                dataId: 'ABC123',
            }),
        ).not.toThrow();
    });

    it('rechaza una firma alterada', () => {
        const ts = '1704908010';
        const valid = signatureFor('ABC123', 'req-1', ts);
        expect(() =>
            mercadoPago.verifyWebhookSignature({
                xSignature: valid,
                xRequestId: 'req-1',
                dataId: 'OTRO-ID',
            }),
        ).toThrow();
    });

    it('rechaza una notificación sin firma', () => {
        expect(() =>
            mercadoPago.verifyWebhookSignature({ xRequestId: 'req-1', dataId: 'ABC123' }),
        ).toThrow();
    });

    it('sin secreto configurado, en producción se rechaza la notificación', () => {
        delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
        process.env.K_SERVICE = 'api';
        try {
            expect(() =>
                mercadoPago.verifyWebhookSignature({ xRequestId: 'req-1', dataId: 'ABC' }),
            ).toThrow();
        } finally {
            delete process.env.K_SERVICE;
            process.env.MERCADOPAGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
        }
    });

    it('sin secreto y fuera de producción se acepta para poder simular avisos', () => {
        delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
        try {
            expect(() =>
                mercadoPago.verifyWebhookSignature({ xRequestId: 'req-1', dataId: 'ABC' }),
            ).not.toThrow();
        } finally {
            process.env.MERCADOPAGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
        }
    });

    it('reconoce los temas con los que llega el avance de una orden', () => {
        expect(mercadoPago.isOrderTopic('order')).toBe(true);
        expect(mercadoPago.isOrderTopic('orders')).toBe(true);
        expect(mercadoPago.isOrderTopic('topic_orders')).toBe(true);
        expect(mercadoPago.isOrderTopic('point_integration_wh')).toBe(true);
        expect(mercadoPago.isOrderTopic(undefined)).toBe(true);
        expect(mercadoPago.isOrderTopic('payment')).toBe(false);
    });

    it('un aviso que no es de orden no consulta a Mercado Pago', async () => {
        mockFetch(200, {});
        const result = await mercadoPago.handleWebhookNotification({
            dataId: '123',
            type: 'payment',
        });

        expect(result).toEqual({ received: true, order: null });
        expect(lastCall).toBeNull();
    });
});
