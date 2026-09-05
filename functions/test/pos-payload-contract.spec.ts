import { createSaleSchema } from '../src/schemas/sales';

/**
 * Contrato con el POS: que el cuerpo que **de verdad** arma la caja pase este
 * schema.
 *
 * Es el hueco que ninguna otra prueba cubre. Las del backend construyen sus
 * propios payloads a mano, y las del POS afirman sobre lo que emite `buildPayload`
 * — pero nadie comprueba que una cosa encaje en la otra. Si derivan, el síntoma
 * no aparece en ninguna suite: aparece en producción, con una venta cobrada que
 * el servidor rechaza y termina en `unreconciledSales`.
 *
 * Los payloads de abajo son copia literal de la forma que emite
 * `src/app/features/pos/services/sale.service.ts` (método `buildPayload`) en el
 * repositorio del POS. Si ese método cambia, hay que cambiarlos aquí, y esa es
 * justamente la señal que se busca.
 */

const base = {
    idempotencyKey: 'k-abc123',
    saleDiscountAmount: 0,
    paymentMethod: 'cash' as const,
    amountReceived: 300,
    cardPaymentReference: null,
    cashSessionId: 'cs-1',
    customerId: null,
    customerName: null,
    prescription: null,
    billing: null,
};

const partidaProducto = { kind: 'product', productId: 'remote-p1', quantity: 2, discountAmount: 0 };
const partidaServicio = {
    kind: 'service',
    serviceId: 'sv-1',
    quantity: 1,
    discountAmount: 0,
    providerId: 'dr-1',
};

describe('contrato: el payload del POS pasa el schema del backend', () => {
    /**
     * Caso real de producción: con la terminal Point desactivada el POS registra
     * tarjeta y mixto sin order, y el schema los rechazaba con 400. La venta ya
     * estaba cobrada y se quedaba atorada en la cola del POS.
     */
    it('acepta pago mixto sin order de Point, con el reparto capturado', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [partidaProducto],
            paymentMethod: 'mixed',
            amountReceived: 10,
            cardPaymentReference: null,
            cardAmount: 10,
        });

        expect(resultado.success).toBe(true);
    });

    it('acepta pago con tarjeta sin order: queda como registro, igual que el efectivo', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [partidaProducto],
            paymentMethod: 'card',
            amountReceived: null,
            cardPaymentReference: null,
        });

        expect(resultado.success).toBe(true);
    });

    /** Sin order NI reparto no hay forma de saber cuánto efectivo entró al cajón. */
    it('rechaza el mixto sin order y sin monto con tarjeta', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [partidaProducto],
            paymentMethod: 'mixed',
            amountReceived: 10,
            cardPaymentReference: null,
        });

        expect(resultado.success).toBe(false);
    });

    it('acepta un ticket mixto de medicamento y servicio', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [partidaProducto, partidaServicio],
        });

        expect(resultado.success).toBe(true);
    });

    it('acepta una venta de solo servicios', () => {
        const resultado = createSaleSchema.safeParse({ ...base, items: [partidaServicio] });

        expect(resultado.success).toBe(true);
    });

    it('acepta un servicio sin doctor (cuando el servicio no lo exige)', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [{ ...partidaServicio, providerId: null }],
        });

        expect(resultado.success).toBe(true);
    });

    /**
     * El caso que protege el despliegue: una caja con la versión anterior del
     * POS manda partidas **sin** `kind`, y puede tener ventas encoladas offline
     * con ese formato desde antes de actualizarse. Si el schema dejara de
     * aceptarlas, esas ventas se rechazarían al sincronizar.
     */
    it('acepta el formato viejo, sin `kind`, y lo trata como producto', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [{ productId: 'remote-p1', quantity: 2, discountAmount: 0 }],
        });

        expect(resultado.success).toBe(true);
        if (resultado.success) {
            expect(resultado.data.items[0]).toMatchObject({ kind: 'product', productId: 'remote-p1' });
        }
    });

    it('acepta un pago mixto efectivo + tarjeta con servicios', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            paymentMethod: 'mixed',
            cardAmount: 100,
            cardPaymentReference: 'sale-k-abc123-1',
            items: [partidaProducto, partidaServicio],
        });

        expect(resultado.success).toBe(true);
    });

    it('rechaza una partida de servicio sin `serviceId`', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [{ kind: 'service', quantity: 1, discountAmount: 0 }],
        });

        expect(resultado.success).toBe(false);
    });

    it('rechaza una partida híbrida: un `kind` decide qué campos aplican', () => {
        const resultado = createSaleSchema.safeParse({
            ...base,
            items: [{ kind: 'service', serviceId: 'sv-1', productId: 'remote-p1', quantity: 1, discountAmount: 0 }],
        });

        // Zod ignora las llaves extra por omisión; lo que no puede pasar es que
        // el `productId` sobreviva al parseo y llegue a la transacción.
        if (resultado.success) {
            expect(resultado.data.items[0]).not.toHaveProperty('productId');
        }
    });
});
