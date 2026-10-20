import { InvoiceWithDetails, SupplierPayment } from '../types';
import { conflict } from '../utils/errors';
import { db } from '../utils/firestore';
import * as invoicesRepo from '../repositories/invoices.repository';
import * as invoicesService from './invoices.service';

/**
 * Idempotencia de los abonos a facturas de proveedor
 * (`POST /invoices/:id/payments`), con el patrón de las entradas de inventario:
 * la pantalla genera una llave por captura y la reenvía sin cambios al reintentar.
 *
 * Sin ella, una respuesta perdida tras un abono que **sí** se registró hacía que
 * el reintento bajara el saldo otra vez. La llave es opcional para no romper a
 * los clientes que aún no la mandan.
 */
const COLLECTION = 'supplierPaymentIdempotencyKeys';
const SCOPE = 'supplier-payment';
const TTL_HOURS = 72;
/** Código gRPC de `create()` sobre un documento que ya existe. */
const ALREADY_EXISTS = 6;

const isAlreadyExists = (error: unknown): boolean =>
    (error as { code?: number } | null)?.code === ALREADY_EXISTS;

export type SupplierPaymentResult = { payment: SupplierPayment; invoice: InvoiceWithDetails };

export const runIdempotentSupplierPayment = async (input: {
    userId: string;
    invoiceId: string;
    key?: string;
    /**
     * Incluye la validación de periodo y la transacción del abono. Si lanza, no
     * quedó nada escrito (el abono es una sola transacción), así que la llave se
     * libera y el mismo intento corregido puede reutilizarla.
     */
    run: () => Promise<SupplierPaymentResult>;
}): Promise<SupplierPaymentResult> => {
    if (!input.key) {
        return input.run();
    }

    const ref = db().collection(COLLECTION).doc(`${input.userId}:${SCOPE}:${input.key}`);

    try {
        // `create` falla si otro intento simultáneo ya la reservó: dos envíos en
        // paralelo no pueden registrar el mismo abono dos veces.
        await ref.create({
            userId: input.userId,
            scope: SCOPE,
            invoiceId: input.invoiceId,
            createdAt: new Date(),
            // Campo para la política TTL de Firestore sobre esta colección.
            expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
        });
    } catch (error) {
        if (!isAlreadyExists(error)) {
            throw error;
        }
        const data = (await ref.get()).data();
        const paymentId = data?.paymentId as string | undefined;
        if (paymentId && data?.invoiceId === input.invoiceId) {
            const payment = await invoicesRepo.getPaymentById(paymentId);
            if (payment) {
                return {
                    payment,
                    invoice: await invoicesService.getInvoice(input.invoiceId),
                };
            }
        }
        throw conflict(
            'Este abono ya se está registrando o quedó a medias en un intento anterior. ' +
                'Revisa la factura antes de volver a capturarlo.',
        );
    }

    try {
        const result = await input.run();
        // Cierra la llave: de aquí en adelante el reintento devuelve este abono.
        await ref.set({ paymentId: result.payment.id }, { merge: true });
        return result;
    } catch (error) {
        await ref.delete().catch(() => undefined);
        throw error;
    }
};
