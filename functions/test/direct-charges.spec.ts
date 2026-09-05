import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import * as directChargesRepo from '../src/repositories/direct-charges.repository';
import * as directChargesService from '../src/services/direct-charges.service';
import * as mercadoPagoService from '../src/services/mercado-pago.service';
import * as salesReportsService from '../src/services/sales-reports.service';
import { AppError } from '../src/utils/errors';
import { db, now, toTimestamp } from '../src/utils/firestore';

/**
 * Cobro directo: dinero que entra por Mercado Pago **sin** una venta detrás.
 *
 * Integración contra el emulador de Firestore con Mercado Pago sustituido —nunca
 * se llama a la API real ni se usan credenciales. Lo que se fija aquí es lo que
 * cuesta dinero si se rompe:
 *
 * 1. Que un reintento del POS tras un timeout no cobre dos veces.
 * 2. Que un cobro ya aprobado no se pueda marcar como cancelado.
 * 3. Que un aviso de webhook repetido o fuera de orden no degrade un cobro que
 *    sí entró.
 * 4. Que estos cobros no aparezcan en el corte de caja ni en los reportes de
 *    ventas, que es la promesa explícita del diseño.
 */

jest.mock('../src/services/mercado-pago.service', () => ({
    createOrder: jest.fn(),
    getOrder: jest.fn(),
    cancelOrder: jest.fn(),
    createCheckoutPreference: jest.fn(),
    expireCheckoutPreference: jest.fn(),
    getPayment: jest.fn(),
    getMerchantOrderPayment: jest.fn(),
    findPaymentByExternalReference: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) =>
    fn as unknown as jest.MockedFunction<T>;

const createOrderMock = mocked(mercadoPagoService.createOrder);
const getOrderMock = mocked(mercadoPagoService.getOrder);
const cancelOrderMock = mocked(mercadoPagoService.cancelOrder);
const createPreferenceMock = mocked(mercadoPagoService.createCheckoutPreference);
const expirePreferenceMock = mocked(mercadoPagoService.expireCheckoutPreference);
const getPaymentMock = mocked(mercadoPagoService.getPayment);
const getMerchantOrderPaymentMock = mocked(mercadoPagoService.getMerchantOrderPayment);
const findPaymentMock = mocked(mercadoPagoService.findPaymentByExternalReference);

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const CAJERO = 'gerente-de-prueba';

type OrderStatus = Parameters<typeof directChargesService.syncDirectCharge> extends never
    ? never
    : 'created' | 'at_terminal' | 'action_required' | 'processed' | 'canceled' | 'refunded'
        | 'failed';

const order = (overrides: {
    id?: string;
    status?: OrderStatus;
    amount?: string;
    statusDetail?: string | null;
    paymentId?: string | null;
} = {}) => ({
    id: overrides.id ?? unique('ORD'),
    status: overrides.status ?? 'created',
    statusDetail: overrides.statusDetail ?? null,
    terminalId: 'NEWLAND_N950__X',
    amount: overrides.amount ?? '150.50',
    externalReference: 'dc-ref',
    paymentId: overrides.paymentId ?? null,
} as unknown as Awaited<ReturnType<typeof mercadoPagoService.getOrder>>);

const preference = (overrides: { id?: string; expiresAt?: string | null } = {}) => ({
    id: overrides.id ?? unique('PREF'),
    initPoint: 'https://mp.test/checkout/abc',
    sandboxInitPoint: 'https://sandbox.mp.test/checkout/abc',
    externalReference: 'se-reemplaza-en-el-mock',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
});

const payment = (overrides: {
    id?: string;
    status?: string;
    externalReference?: string | null;
    statusDetail?: string | null;
} = {}) => ({
    id: overrides.id ?? unique('PAY'),
    status: overrides.status ?? 'approved',
    statusDetail: overrides.statusDetail ?? null,
    amount: 150.5,
    externalReference: overrides.externalReference ?? null,
});

/** Alta por terminal con Mercado Pago aceptando la order. */
const crearCobro = async (overrides: {
    amount?: number;
    concept?: string;
    idempotencyKey?: string;
    status?: OrderStatus;
    orderId?: string;
    cashierId?: string;
} = {}) => {
    const orderId = overrides.orderId ?? unique('ORD');
    createOrderMock.mockResolvedValueOnce(
        order({ id: orderId, status: overrides.status ?? 'created' }),
    );
    const charge = await directChargesService.createDirectCharge({
        deviceId: 'NEWLAND_N950__X',
        amount: overrides.amount ?? 150.5,
        concept: overrides.concept ?? 'Consulta médica',
        idempotencyKey: overrides.idempotencyKey,
        cashierId: overrides.cashierId ?? CAJERO,
        roleSlug: 'manager',
    });
    return { charge, orderId };
};

/** Alta de link en línea. El mock respeta la `externalReference` que pide el servicio. */
const crearCobroEnLinea = async (overrides: {
    amount?: number;
    concept?: string;
    idempotencyKey?: string;
    expiresAt?: string | null;
    preferenceId?: string;
} = {}) => {
    const preferenceId = overrides.preferenceId ?? unique('PREF');
    createPreferenceMock.mockImplementationOnce(async (input) => ({
        ...preference({ id: preferenceId, expiresAt: overrides.expiresAt }),
        externalReference: input.externalReference,
    }));
    const charge = await directChargesService.createOnlineDirectCharge({
        amount: overrides.amount ?? 150.5,
        concept: overrides.concept ?? 'Abono de servicio',
        idempotencyKey: overrides.idempotencyKey,
        cashierId: CAJERO,
        roleSlug: 'manager',
    });
    return { charge, preferenceId };
};

/** Estado crudo en Firestore: lo que de verdad quedó persistido. */
const documentoDe = async (id: string) => {
    const doc = await db().collection('directCharges').doc(id).get();
    return doc.data()!;
};

const folioSequence = (folio: string): number => Number(folio.replace('CD-', ''));

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createDirectCharge: alta con terminal', () => {
    it('persiste el cobro con lo que la caja necesita para resolverlo', async () => {
        const { charge, orderId } = await crearCobro({
            amount: 150.5,
            concept: '  Consulta médica  ',
        });

        expect(charge).toMatchObject({
            amount: 150.5,
            // El concepto se guarda recortado: es lo que se imprime y se busca.
            concept: 'Consulta médica',
            channel: 'point',
            status: 'pending',
            cashierId: CAJERO,
            roleSlug: 'manager',
            canceledBy: null,
            canceledAt: null,
            approvedAt: null,
        });
        expect(charge.point).toMatchObject({
            orderId,
            status: 'created',
            terminalId: 'NEWLAND_N950__X',
        });
        expect(charge.online).toBeNull();

        const doc = await documentoDe(charge.id);
        expect(doc.folio).toBe(charge.folio);
        expect(doc.amount).toBe(150.5);
        expect(doc.channel).toBe('point');
        expect(doc.status).toBe('pending');
        expect(doc.cashierId).toBe(CAJERO);
        expect(doc.createdAt).toBeDefined();
        expect(doc.updatedAt).toBeDefined();
        // Un cobro directo no guarda partidas ni referencia a una venta: si algún
        // día lo hiciera, dejaría de ser aislado del inventario.
        expect(doc.items).toBeUndefined();
        expect(doc.saleId).toBeUndefined();
    });

    it('manda a la terminal el monto, el concepto recortado y el deviceId', async () => {
        await crearCobro({ amount: 90, concept: 'x'.repeat(200) });

        expect(createOrderMock).toHaveBeenCalledTimes(1);
        const input = createOrderMock.mock.calls[0][0];
        expect(input.amount).toBe(90);
        expect(input.deviceId).toBe('NEWLAND_N950__X');
        // Mercado Pago acota la descripción; se recorta antes de mandarla.
        expect(input.description).toHaveLength(150);
    });

    it('rechaza un monto de cero o negativo sin hablar con Mercado Pago', async () => {
        for (const amount of [0, -1, Number.NaN]) {
            await expect(
                directChargesService.createDirectCharge({
                    deviceId: 'D1',
                    amount,
                    concept: 'Consulta',
                    cashierId: CAJERO,
                }),
            ).rejects.toMatchObject({ statusCode: 400 });
        }
        expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('rechaza el concepto vacío sin hablar con Mercado Pago', async () => {
        await expect(
            directChargesService.createDirectCharge({
                deviceId: 'D1',
                amount: 10,
                concept: '    ',
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('una terminal inexistente o fuera de modo PDV no deja cobro registrado', async () => {
        // Es el rechazo real de Mercado Pago cuando la terminal no está en PDV.
        createOrderMock.mockRejectedValueOnce(
            new AppError(400, 'BAD_REQUEST', 'Terminal no está en modo PDV'),
        );

        await expect(
            directChargesService.createDirectCharge({
                deviceId: 'TERMINAL_FANTASMA',
                amount: 10,
                concept: 'Consulta',
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 400, message: 'Terminal no está en modo PDV' });

        // Sin order aceptada no hay documento: un cobro sin order es un registro
        // que la caja no puede resolver ni cancelar.
        const { items } = await directChargesRepo.listDirectCharges({ limit: 100 });
        expect(items.some((item) => item.point?.terminalId === 'TERMINAL_FANTASMA')).toBe(false);
    });

    it('asigna folios consecutivos con el contador de directCharges', async () => {
        const primero = await crearCobro();
        const segundo = await crearCobro();

        expect(primero.charge.folio).toMatch(/^CD-\d{6}$/);
        expect(folioSequence(segundo.charge.folio))
            .toBe(folioSequence(primero.charge.folio) + 1);

        const counter = await db().collection('counters').doc('directCharges').get();
        expect(counter.data()?.value).toBe(folioSequence(segundo.charge.folio));
    });

    it('si la terminal ya cobró al crear la order, nace aprobado con approvedAt', async () => {
        const { charge } = await crearCobro({ status: 'processed' });

        expect(charge.status).toBe('approved');
        expect(charge.approvedAt).not.toBeNull();
    });

    it('una order rechazada nace failed y no queda como pendiente eterno', async () => {
        const { charge } = await crearCobro({ status: 'failed' });

        expect(charge.status).toBe('failed');
        expect(charge.approvedAt).toBeNull();
    });
});

describe('createOnlineDirectCharge: alta de link de pago', () => {
    it('crea la preferencia y guarda el link, la referencia y la caducidad', async () => {
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const { charge, preferenceId } = await crearCobroEnLinea({ expiresAt });

        expect(charge).toMatchObject({ channel: 'online', status: 'pending', amount: 150.5 });
        expect(charge.point).toBeNull();
        expect(charge.online).toMatchObject({
            preferenceId,
            initPoint: 'https://mp.test/checkout/abc',
            paymentId: null,
            paymentStatus: null,
            expiresAt,
        });
        // El prefijo es lo que distingue nuestros cobros de cualquier otro pago
        // de la misma cuenta de Mercado Pago cuando llega un webhook.
        expect(charge.online?.externalReference.startsWith('dco-')).toBe(true);
    });

    it('el link vence en 30 minutos: un link viejo es un cobro sorpresa', async () => {
        await crearCobroEnLinea();

        expect(createPreferenceMock.mock.calls[0][0].expirationMinutes).toBe(30);
    });

    it('rechaza monto y concepto inválidos sin crear la preferencia', async () => {
        await expect(
            directChargesService.createOnlineDirectCharge({
                amount: 0,
                concept: 'Abono',
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            directChargesService.createOnlineDirectCharge({
                amount: 10,
                concept: '   ',
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(createPreferenceMock).not.toHaveBeenCalled();
    });

    it('si Mercado Pago rechaza la preferencia no queda cobro registrado', async () => {
        createPreferenceMock.mockRejectedValueOnce(
            new AppError(502, 'MERCADOPAGO_UNAVAILABLE', 'Servicio no disponible'),
        );
        const key = unique('key-pref-falla-0000');

        await expect(
            directChargesService.createOnlineDirectCharge({
                amount: 10,
                concept: 'Abono',
                idempotencyKey: key,
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 502 });

        // La llave se libera para que el cajero reintente sin esperar el TTL.
        const { charge } = await crearCobroEnLinea({ idempotencyKey: key, amount: 10 });
        expect(charge.status).toBe('pending');
    });

    it('los folios comparten contador con los cobros por terminal', async () => {
        const terminal = await crearCobro();
        const linea = await crearCobroEnLinea();

        expect(linea.charge.folio).toMatch(/^CD-\d{6}$/);
        expect(folioSequence(linea.charge.folio))
            .toBe(folioSequence(terminal.charge.folio) + 1);
    });
});

describe('idempotencia: el POS reintenta tras un timeout', () => {
    it('la misma llave devuelve el mismo cobro y NO vuelve a cobrar', async () => {
        const key = unique('key-retry-000000');

        const primero = await crearCobro({ idempotencyKey: key, amount: 200 });
        // El segundo envío no debe llegar a Mercado Pago: si llegara, la terminal
        // cobraría dos veces.
        const segundo = await directChargesService.createDirectCharge({
            deviceId: 'NEWLAND_N950__X',
            amount: 200,
            concept: 'Consulta médica',
            idempotencyKey: key,
            cashierId: CAJERO,
            roleSlug: 'manager',
        });

        expect(segundo.id).toBe(primero.charge.id);
        expect(segundo.folio).toBe(primero.charge.folio);
        expect(createOrderMock).toHaveBeenCalledTimes(1);

        // Y solo hay un documento con ese folio.
        const { items } = await directChargesRepo.listDirectCharges({ limit: 100 });
        expect(items.filter((item) => item.folio === primero.charge.folio)).toHaveLength(1);
    });

    it('la llave se guarda por cajero: la de otro no devuelve un cobro ajeno', async () => {
        const key = unique('key-porcajero-0000');

        const mio = await crearCobro({ idempotencyKey: key, cashierId: 'gerente-a' });
        const suyo = await crearCobro({ idempotencyKey: key, cashierId: 'gerente-b' });

        expect(suyo.charge.id).not.toBe(mio.charge.id);
        expect(createOrderMock).toHaveBeenCalledTimes(2);
    });

    it('un envío todavía en vuelo responde 409, no un segundo cobro', async () => {
        const key = unique('key-envuelo-00000');
        // Reserva viva sin cobro: es exactamente lo que deja el primer envío
        // mientras Mercado Pago no contesta.
        await db()
            .collection('directChargeIdempotencyKeys')
            .doc(`${CAJERO}:${key}`)
            .set({ cashierId: CAJERO, amount: 150.5, chargeId: null, createdAt: now() });

        await expect(
            directChargesService.createDirectCharge({
                deviceId: 'NEWLAND_N950__X',
                amount: 150.5,
                concept: 'Consulta médica',
                idempotencyKey: key,
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(createOrderMock).not.toHaveBeenCalled();
    });

    it('la misma llave con OTRO monto responde 409 en vez del cobro anterior', async () => {
        const key = unique('key-otromonto-000');
        await crearCobro({ idempotencyKey: key, amount: 90 });

        // Devolver el cobro de 90 contestaría 201 y el gerente creería que se
        // cobraron 900. La llave identifica una operación, no un monto libre.
        await expect(
            directChargesService.createDirectCharge({
                deviceId: 'NEWLAND_N950__X',
                amount: 900,
                concept: 'Consulta médica',
                idempotencyKey: key,
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(createOrderMock).toHaveBeenCalledTimes(1);
    });

    it('la misma llave en otro canal responde 409: no devuelve un cobro sin link', async () => {
        const key = unique('key-otrocanal-000');
        await crearCobro({ idempotencyKey: key, amount: 150.5 });

        await expect(
            directChargesService.createOnlineDirectCharge({
                amount: 150.5,
                concept: 'Abono de servicio',
                idempotencyKey: key,
                cashierId: CAJERO,
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(createPreferenceMock).not.toHaveBeenCalled();
    });

    it('el cobro en línea también deduplica por llave', async () => {
        const key = unique('key-online-000000');

        const primero = await crearCobroEnLinea({ idempotencyKey: key });
        const segundo = await directChargesService.createOnlineDirectCharge({
            amount: 150.5,
            concept: 'Abono de servicio',
            idempotencyKey: key,
            cashierId: CAJERO,
        });

        expect(segundo.id).toBe(primero.charge.id);
        expect(createPreferenceMock).toHaveBeenCalledTimes(1);
    });

    it('SIN llave no hay defensa: dos envíos son dos cobros (contrato vigente)', async () => {
        // Fija el comportamiento actual a propósito. La llave la genera el POS y
        // es opcional en el schema, así que un reintento sin ella sí cobra dos
        // veces: la defensa vive en el cliente. Si algún día se vuelve
        // obligatoria, esta prueba es la que debe cambiar.
        const primero = await crearCobro({ concept: 'Sin llave' });
        const segundo = await crearCobro({ concept: 'Sin llave' });

        expect(segundo.charge.id).not.toBe(primero.charge.id);
        expect(createOrderMock).toHaveBeenCalledTimes(2);
    });
});

describe('consulta', () => {
    it('un id inexistente da 404, no 500', async () => {
        const error = await directChargesService
            .getDirectCharge('no-existe-este-cobro')
            .catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(404);
    });

    it('sincronizar un id inexistente también da 404 y no consulta a Mercado Pago', async () => {
        await expect(directChargesService.syncDirectCharge('no-existe'))
            .rejects.toMatchObject({ statusCode: 404 });
        expect(getOrderMock).not.toHaveBeenCalled();
    });

    it('filtra por estado, canal y texto', async () => {
        const marca = unique('MARCA');
        const pendiente = await crearCobro({ concept: `${marca} pendiente` });
        await crearCobro({ concept: `${marca} aprobado`, status: 'processed' });
        await crearCobroEnLinea({ concept: `${marca} en linea` });

        const porTexto = await directChargesService.listDirectCharges({ search: marca });
        expect(porTexto.items).toHaveLength(3);
        expect(porTexto.meta.total).toBe(3);

        const soloPendientes = await directChargesService.listDirectCharges({
            search: marca,
            status: 'pending',
        });
        expect(soloPendientes.items.map((item) => item.id)).toContain(pendiente.charge.id);
        expect(soloPendientes.items.every((item) => item.status === 'pending')).toBe(true);

        const soloLinea = await directChargesService.listDirectCharges({
            search: marca,
            channel: 'online',
        });
        expect(soloLinea.items).toHaveLength(1);
        expect(soloLinea.items[0].channel).toBe('online');

        const porFolio = await directChargesService.listDirectCharges({
            search: pendiente.charge.folio,
        });
        expect(porFolio.items.map((item) => item.id)).toContain(pendiente.charge.id);
    });

    it('pagina y reporta el total sin paginar', async () => {
        const marca = unique('PAGINA');
        await crearCobro({ concept: `${marca} uno` });
        await crearCobro({ concept: `${marca} dos` });
        await crearCobro({ concept: `${marca} tres` });

        const pagina1 = await directChargesService.listDirectCharges({
            search: marca,
            page: 1,
            limit: 2,
        });
        expect(pagina1.items).toHaveLength(2);
        expect(pagina1.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });

        const pagina2 = await directChargesService.listDirectCharges({
            search: marca,
            page: 2,
            limit: 2,
        });
        expect(pagina2.items).toHaveLength(1);
        // Sin traslape entre páginas: el orden es estable (createdAt desc).
        const idsPagina1 = pagina1.items.map((item) => item.id);
        expect(idsPagina1).not.toContain(pagina2.items[0].id);
    });

    it('rechaza un límite fuera del tope en vez de traer toda la colección', async () => {
        await expect(directChargesService.listDirectCharges({ limit: 1000 }))
            .rejects.toMatchObject({ statusCode: 400 });
        await expect(directChargesService.listDirectCharges({ page: 0 }))
            .rejects.toMatchObject({ statusCode: 400 });
    });

    it('la ventana por defecto es de 30 días: un cobro viejo no sale sin pedirlo', async () => {
        const marca = unique('VIEJO');
        const { charge } = await crearCobro({ concept: `${marca} antiguo` });
        // Se envejece el documento en Firestore, que es lo que filtra la lista.
        const hace60Dias = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
        await db()
            .collection('directCharges')
            .doc(charge.id)
            .update({ createdAt: toTimestamp(hace60Dias) });

        const porDefecto = await directChargesService.listDirectCharges({ search: marca });
        expect(porDefecto.items).toHaveLength(0);

        const conRango = await directChargesService.listDirectCharges({
            search: marca,
            from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        });
        expect(conRango.items.map((item) => item.id)).toContain(charge.id);
    });
});

describe('cancelación', () => {
    it('cancela un cobro pendiente: cancela la order y registra a quién y cuándo', async () => {
        const { charge, orderId } = await crearCobro();
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'created' }));
        cancelOrderMock.mockResolvedValueOnce(undefined);

        const cancelado = await directChargesService.cancelDirectCharge(charge.id, {
            userId: 'gerente-que-cancela',
            roleSlug: 'manager',
        });

        expect(cancelOrderMock).toHaveBeenCalledWith(orderId);
        expect(cancelado.status).toBe('canceled');
        expect(cancelado.canceledBy).toBe('gerente-que-cancela');
        expect(cancelado.canceledAt).not.toBeNull();

        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('canceled');
        expect(doc.canceledBy).toBe('gerente-que-cancela');
    });

    it('cancela un cobro en línea venciendo la preferencia', async () => {
        const { charge, preferenceId } = await crearCobroEnLinea();
        findPaymentMock.mockResolvedValueOnce(null);
        expirePreferenceMock.mockResolvedValueOnce(undefined);

        const cancelado = await directChargesService.cancelDirectCharge(charge.id, {
            userId: 'gerente-que-cancela',
        });

        expect(expirePreferenceMock).toHaveBeenCalledWith(preferenceId);
        expect(cancelado.status).toBe('canceled');
    });

    it('NO cancela un cobro ya aprobado: ese dinero requiere un reembolso', async () => {
        const { charge } = await crearCobro({ status: 'processed' });
        expect(charge.status).toBe('approved');

        await expect(
            directChargesService.cancelDirectCharge(charge.id, { userId: 'gerente' }),
        ).rejects.toMatchObject({ statusCode: 400 });

        // Ni se tocó Mercado Pago ni cambió el documento.
        expect(cancelOrderMock).not.toHaveBeenCalled();
        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('approved');
        expect(doc.canceledBy).toBeNull();
    });

    it('tampoco lo cancela si el documento local seguía pendiente', async () => {
        // El caso caro: la terminal cobró, el sondeo o el webhook no alcanzaron a
        // verlo y el documento seguía `pending`. Cancelar aquí dejaría un cobro
        // marcado `canceled` con el dinero adentro.
        const { charge, orderId } = await crearCobro();
        expect(charge.status).toBe('pending');
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'processed' }));

        await expect(
            directChargesService.cancelDirectCharge(charge.id, { userId: 'gerente' }),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(cancelOrderMock).not.toHaveBeenCalled();
        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('approved');
        expect(doc.canceledBy).toBeNull();
    });

    it('lo mismo en el canal en línea: un pago aprobado no se vence, se reembolsa', async () => {
        const { charge } = await crearCobroEnLinea();
        findPaymentMock.mockResolvedValueOnce(
            payment({ status: 'approved', externalReference: charge.online!.externalReference }),
        );

        await expect(
            directChargesService.cancelDirectCharge(charge.id, { userId: 'gerente' }),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(expirePreferenceMock).not.toHaveBeenCalled();
        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('approved');
    });

    it('la doble cancelación es idempotente y no repite la llamada a Mercado Pago', async () => {
        const { charge, orderId } = await crearCobro();
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'created' }));
        cancelOrderMock.mockResolvedValueOnce(undefined);

        const primera = await directChargesService.cancelDirectCharge(charge.id, {
            userId: 'gerente-uno',
        });
        const segunda = await directChargesService.cancelDirectCharge(charge.id, {
            userId: 'gerente-dos',
        });

        expect(segunda.status).toBe('canceled');
        // El segundo intento no reescribe el responsable: quien canceló fue el primero.
        expect(segunda.canceledBy).toBe('gerente-uno');
        expect(segunda.canceledAt).toEqual(primera.canceledAt);
        expect(cancelOrderMock).toHaveBeenCalledTimes(1);
    });

    it('cancelar un id inexistente da 404', async () => {
        await expect(
            directChargesService.cancelDirectCharge('no-existe', { userId: 'gerente' }),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('si Mercado Pago no acepta cancelar la order, el cobro NO queda cancelado', async () => {
        // Una order que la terminal ya tomó solo se cancela en la terminal.
        const { charge, orderId } = await crearCobro();
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'at_terminal' }));
        cancelOrderMock.mockRejectedValueOnce(
            new AppError(400, 'BAD_REQUEST', 'Cancela el cobro desde la terminal'),
        );

        await expect(
            directChargesService.cancelDirectCharge(charge.id, { userId: 'gerente' }),
        ).rejects.toMatchObject({ statusCode: 400 });

        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('pending');
        expect(doc.canceledBy).toBeNull();
    });
});

describe('estados: sondeo del POS', () => {
    it('pendiente → aprobado sella approvedAt y guarda el paymentId', async () => {
        const { charge, orderId } = await crearCobro();
        getOrderMock.mockResolvedValueOnce(
            order({ id: orderId, status: 'processed', paymentId: 'PAY-9' }),
        );

        const sincronizado = await directChargesService.syncDirectCharge(charge.id);

        expect(sincronizado.status).toBe('approved');
        expect(sincronizado.approvedAt).not.toBeNull();
        expect(sincronizado.point?.paymentId).toBe('PAY-9');
    });

    it('mientras la order sigue en la terminal el cobro sigue pendiente', async () => {
        const { charge, orderId } = await crearCobro();

        for (const status of ['created', 'at_terminal', 'action_required'] as const) {
            getOrderMock.mockResolvedValueOnce(order({ id: orderId, status }));
            const sincronizado = await directChargesService.syncDirectCharge(charge.id);
            expect(sincronizado.status).toBe('pending');
        }
    });

    it('un cobro ya resuelto no vuelve a consultar a Mercado Pago', async () => {
        const { charge } = await crearCobro({ status: 'processed' });

        const sincronizado = await directChargesService.syncDirectCharge(charge.id);

        expect(sincronizado.status).toBe('approved');
        expect(getOrderMock).not.toHaveBeenCalled();
    });

    it('una order reembolsada deja el cobro como cancelado', async () => {
        const { charge, orderId } = await crearCobro();
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'refunded' }));

        const sincronizado = await directChargesService.syncDirectCharge(charge.id);

        expect(sincronizado.status).toBe('canceled');
    });

    it('un link vencido sin pago pasa a failed en vez de quedar pendiente', async () => {
        const { charge } = await crearCobroEnLinea({
            expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        });
        findPaymentMock.mockResolvedValueOnce(null);

        const sincronizado = await directChargesService.syncDirectCharge(charge.id);

        expect(sincronizado.status).toBe('failed');
        expect(sincronizado.statusDetail).toMatch(/venció/);
    });

    it('un link vigente sin pago todavía sigue pendiente', async () => {
        const { charge } = await crearCobroEnLinea();
        findPaymentMock.mockResolvedValueOnce(null);

        const sincronizado = await directChargesService.syncDirectCharge(charge.id);

        expect(sincronizado.status).toBe('pending');
    });

    it('un pago autorizado sin capturar NO es cobrado: sigue pendiente', async () => {
        const { charge } = await crearCobroEnLinea();
        findPaymentMock.mockResolvedValueOnce(
            payment({
                status: 'authorized',
                externalReference: charge.online!.externalReference,
            }),
        );

        const sincronizado = await directChargesService.syncDirectCharge(charge.id);

        expect(sincronizado.status).toBe('pending');
        expect(sincronizado.approvedAt).toBeNull();
    });
});

describe('estados: webhook de Mercado Pago', () => {
    it('un aviso de order resuelve el cobro con terminal', async () => {
        const { charge, orderId } = await crearCobro();
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'processed' }));

        const resuelto = await directChargesService.syncPointChargeFromOrder(orderId);

        expect(resuelto?.id).toBe(charge.id);
        expect(resuelto?.status).toBe('approved');
    });

    it('una order ajena devuelve null: puede ser de una venta', async () => {
        const resuelto = await directChargesService.syncPointChargeFromOrder('ORDEN-DE-VENTA');

        expect(resuelto).toBeNull();
        expect(getOrderMock).not.toHaveBeenCalled();
    });

    it('un aviso de pago resuelve el cobro en línea', async () => {
        const { charge } = await crearCobroEnLinea();
        getPaymentMock.mockResolvedValueOnce(
            payment({
                id: 'PAY-77',
                status: 'approved',
                externalReference: charge.online!.externalReference,
            }),
        );

        const resuelto = await directChargesService.syncOnlineChargeFromPayment('PAY-77');

        expect(resuelto?.id).toBe(charge.id);
        expect(resuelto?.status).toBe('approved');
        expect(resuelto?.online?.paymentId).toBe('PAY-77');
        expect(resuelto?.online?.paymentStatus).toBe('approved');
    });

    it('un pago sin nuestro prefijo devuelve null: no es un cobro directo', async () => {
        getPaymentMock.mockResolvedValueOnce(
            payment({ externalReference: 'venta-123' }),
        );
        expect(await directChargesService.syncOnlineChargeFromPayment('PAY-X')).toBeNull();

        getPaymentMock.mockResolvedValueOnce(payment({ externalReference: null }));
        expect(await directChargesService.syncOnlineChargeFromPayment('PAY-Y')).toBeNull();
    });

    it('el aviso de merchant_order es la red de seguridad del aviso de pago', async () => {
        const { charge } = await crearCobroEnLinea();
        getMerchantOrderPaymentMock.mockResolvedValueOnce(
            payment({
                id: 'PAY-88',
                status: 'approved',
                externalReference: charge.online!.externalReference,
            }),
        );

        const resuelto = await directChargesService
            .syncOnlineChargeFromMerchantOrder('MO-1');

        expect(resuelto?.id).toBe(charge.id);
        expect(resuelto?.status).toBe('approved');
    });

    it('una merchant_order sin pagos devuelve null', async () => {
        getMerchantOrderPaymentMock.mockResolvedValueOnce(null);
        expect(await directChargesService.syncOnlineChargeFromMerchantOrder('MO-2')).toBeNull();
    });

    it('el mismo aviso repetido deja el cobro igual', async () => {
        const { charge } = await crearCobroEnLinea();
        const evento = payment({
            id: 'PAY-REPE',
            status: 'approved',
            externalReference: charge.online!.externalReference,
        });

        getPaymentMock.mockResolvedValueOnce(evento);
        const primera = await directChargesService.syncOnlineChargeFromPayment('PAY-REPE');
        getPaymentMock.mockResolvedValueOnce(evento);
        const segunda = await directChargesService.syncOnlineChargeFromPayment('PAY-REPE');

        expect(segunda?.status).toBe('approved');
        // No se reescribe: el mismo aviso no debe mover `updatedAt` ni `approvedAt`.
        expect(segunda?.approvedAt).toEqual(primera?.approvedAt);
        expect(segunda?.updatedAt).toEqual(primera?.updatedAt);
    });

    it('un aviso ATRASADO de un intento rechazado no tumba un cobro aprobado', async () => {
        // Una preferencia admite varios intentos. Si el aviso del rechazado llega
        // después del aprobado, marcar `failed` sería declarar perdido dinero que
        // sí entró.
        const { charge } = await crearCobroEnLinea();
        const referencia = charge.online!.externalReference;

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-OK', status: 'approved', externalReference: referencia }),
        );
        await directChargesService.syncOnlineChargeFromPayment('PAY-OK');

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-NO', status: 'rejected', externalReference: referencia }),
        );
        const despues = await directChargesService.syncOnlineChargeFromPayment('PAY-NO');

        expect(despues?.status).toBe('approved');
        expect(despues?.online?.paymentId).toBe('PAY-OK');
        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('approved');
    });

    it('un aviso atrasado con el pago en proceso no devuelve el cobro a pendiente', async () => {
        const { charge } = await crearCobroEnLinea();
        const referencia = charge.online!.externalReference;

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-OK2', status: 'approved', externalReference: referencia }),
        );
        await directChargesService.syncOnlineChargeFromPayment('PAY-OK2');

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-OK2', status: 'in_process', externalReference: referencia }),
        );
        const despues = await directChargesService.syncOnlineChargeFromPayment('PAY-OK2');

        expect(despues?.status).toBe('approved');
    });

    it('un reembolso posterior SÍ pasa el cobro a cancelado', async () => {
        // La contracara: el candado no debe bloquear la reversión real.
        const { charge } = await crearCobroEnLinea();
        const referencia = charge.online!.externalReference;

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-R', status: 'approved', externalReference: referencia }),
        );
        await directChargesService.syncOnlineChargeFromPayment('PAY-R');

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-R', status: 'refunded', externalReference: referencia }),
        );
        const despues = await directChargesService.syncOnlineChargeFromPayment('PAY-R');

        expect(despues?.status).toBe('canceled');
        expect(await documentoDe(charge.id).then((doc) => doc.status)).toBe('canceled');
    });

    it('un contracargo posterior también cancela el cobro', async () => {
        const { charge } = await crearCobroEnLinea();
        const referencia = charge.online!.externalReference;

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-CB', status: 'approved', externalReference: referencia }),
        );
        await directChargesService.syncOnlineChargeFromPayment('PAY-CB');
        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-CB', status: 'charged_back', externalReference: referencia }),
        );

        expect((await directChargesService.syncOnlineChargeFromPayment('PAY-CB'))?.status)
            .toBe('canceled');
    });

    it('un cobro cancelado no revive con un aviso posterior de pago aprobado', async () => {
        const { charge } = await crearCobroEnLinea();
        const referencia = charge.online!.externalReference;
        findPaymentMock.mockResolvedValueOnce(null);
        expirePreferenceMock.mockResolvedValueOnce(undefined);
        await directChargesService.cancelDirectCharge(charge.id, { userId: 'gerente' });

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-Z', status: 'approved', externalReference: referencia }),
        );
        const despues = await directChargesService.syncOnlineChargeFromPayment('PAY-Z');

        expect(despues?.status).toBe('canceled');
        const doc = await documentoDe(charge.id);
        expect(doc.status).toBe('canceled');
        expect(doc.canceledBy).toBe('gerente');
    });

    it('un rechazo previo no impide que un segundo intento aprobado cobre', async () => {
        const { charge } = await crearCobroEnLinea();
        const referencia = charge.online!.externalReference;

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-1', status: 'rejected', externalReference: referencia }),
        );
        expect((await directChargesService.syncOnlineChargeFromPayment('PAY-1'))?.status)
            .toBe('failed');

        getPaymentMock.mockResolvedValueOnce(
            payment({ id: 'PAY-2', status: 'approved', externalReference: referencia }),
        );
        const aprobado = await directChargesService.syncOnlineChargeFromPayment('PAY-2');

        expect(aprobado?.status).toBe('approved');
        expect(aprobado?.approvedAt).not.toBeNull();
    });

    it('un aviso de order atrasado no degrada un cobro con terminal ya aprobado', async () => {
        const { charge, orderId } = await crearCobro({ status: 'processed' });
        // La bitácora de eventos descarta el reenvío del mismo aviso, pero no un
        // aviso distinto que llegue con el estado viejo de la order.
        await db().collection('directCharges').doc(charge.id).update({ status: 'approved' });
        getOrderMock.mockResolvedValueOnce(order({ id: orderId, status: 'at_terminal' }));

        const despues = await directChargesService.syncPointChargeFromOrder(orderId);

        expect(despues?.status).toBe('approved');
    });
});

describe('aislamiento: el cobro directo no es una venta', () => {
    it('un cobro aprobado no entra al corte de caja', async () => {
        const session = await cashSessionsRepo.createCashSession({
            openedBy: 'gerente-corte',
            openingAmount: 500,
            expectedCashAmount: null,
            countedCashAmount: null,
            cashDifference: null,
            closedBy: null,
            closedAt: null,
        });

        await crearCobro({ amount: 1234.56, status: 'processed', cashierId: 'gerente-corte' });
        await crearCobroEnLinea({ amount: 777.77 });

        const { summary, expectedCashAmount } = await cashSessionsService.getSessionSummary(
            session.id,
            'gerente-corte',
            'manager',
        );

        expect(summary.salesCount).toBe(0);
        expect(summary.grandTotal).toBe(0);
        expect(summary.byMethod.card.total).toBe(0);
        expect(summary.byMethod.cash.total).toBe(0);
        // El esperado del cajón es solo el fondo inicial: el cobro directo no
        // suma ni resta efectivo del turno.
        expect(expectedCashAmount).toBe(500);
        expect(summary.cashInDrawer).toBe(500);
    });

    it('un cobro aprobado no cambia el reporte diario de ventas', async () => {
        const hoy = new Date().toISOString().slice(0, 10);
        const antes = await salesReportsService.buildDailyReport(hoy);

        await crearCobro({ amount: 4321, status: 'processed', concept: 'Cobro fuera de ticket' });

        const despues = await salesReportsService.buildDailyReport(hoy);

        expect(despues.totals).toEqual(antes.totals);
        expect(despues.sales).toEqual(antes.sales);
        expect(despues.topProducts).toEqual(antes.topProducts);
    });

    it('el cobro vive en su propia colección y no deja renglón en sales', async () => {
        const { charge } = await crearCobro({ amount: 55.55, status: 'processed' });

        expect((await db().collection('directCharges').doc(charge.id).get()).exists).toBe(true);
        expect((await db().collection('sales').doc(charge.id).get()).exists).toBe(false);

        // Ni ninguna venta apunta al cobro.
        const referencias = await db()
            .collection('sales')
            .where('directChargeId', '==', charge.id)
            .get();
        expect(referencias.empty).toBe(true);
    });

    it('no genera movimientos de inventario ni de caja', async () => {
        const { charge } = await crearCobro({ amount: 66.66, status: 'processed' });

        const movimientosInventario = await db()
            .collection('stockMovements')
            .where('referenceId', '==', charge.id)
            .get();
        expect(movimientosInventario.empty).toBe(true);

        const movimientosCaja = await db()
            .collection('cashMovements')
            .where('referenceId', '==', charge.id)
            .get();
        expect(movimientosCaja.empty).toBe(true);
    });

    it('el cobro no guarda cashSessionId: no pertenece a ningún turno', async () => {
        const { charge } = await crearCobro();

        const doc = await documentoDe(charge.id);
        expect(doc.cashSessionId).toBeUndefined();
        // Sí guarda quién cobró, que es el único rastro de responsabilidad.
        expect(doc.cashierId).toBe(CAJERO);
        expect(doc.roleSlug).toBe('manager');
    });
});
