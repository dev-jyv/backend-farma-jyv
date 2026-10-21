import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../src/utils/firestore';
import * as salesRepo from '../src/repositories/sales.repository';
import * as eventsRepo from '../src/repositories/mercado-pago-events.repository';
import * as mercadoPagoService from '../src/services/mercado-pago.service';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const seedSale = (orderId: string, voided: boolean) => db().collection('sales').add({
    folio: unique('V'),
    items: [],
    total: 10,
    paymentMethod: 'card',
    pointPayment: { orderId, paymentId: 'PAY', status: 'processed' },
    voidedAt: voided ? Timestamp.now() : null,
    createdAt: Timestamp.now(),
}).then((ref) => ref.id);

describe('findSaleByPointOrderId', () => {
    it('prefiere la venta viva aunque haya una anulada sobre la misma order', async () => {
        const orderId = unique('ORD');
        await seedSale(orderId, true);
        const liveId = await seedSale(orderId, false);

        const found = await salesRepo.findSaleByPointOrderId(orderId);

        // Con limit(1) la anulada podía tapar a la viva y la order se reutilizaba.
        expect(found?.id).toBe(liveId);
        expect(found?.voidedAt).toBeNull();
    });

    it('si solo hay anuladas devuelve una anulada y si no hay nada, null', async () => {
        const orderId = unique('ORD');
        await seedSale(orderId, true);

        expect((await salesRepo.findSaleByPointOrderId(orderId))?.voidedAt).toBeTruthy();
        expect(await salesRepo.findSaleByPointOrderId(unique('NOPE'))).toBeNull();
    });
});

describe('refundOrder', () => {
    it('rechaza un reembolso parcial sin id de pago (no reembolsa toda la order)', async () => {
        await expect(mercadoPagoService.refundOrder({ orderId: 'ORD-1', amount: 5 }))
            .rejects.toMatchObject({ statusCode: 400 });
    });
});

describe('registerWebhookEvent', () => {
    it('el primer envío es nuevo y el reenvío con el mismo x-request-id es duplicado', async () => {
        const requestId = unique('req');
        const input = { requestId, type: 'payment', dataId: 'PAY-1' };

        expect(await eventsRepo.registerWebhookEvent(input)).toBe(true);
        expect(await eventsRepo.registerWebhookEvent(input)).toBe(false);
    });
});
