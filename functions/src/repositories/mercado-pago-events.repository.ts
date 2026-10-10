import { db, now } from '../utils/firestore';

/**
 * Bitácora de notificaciones de Mercado Pago.
 *
 * Mercado Pago reenvía cada aviso hasta recibir un 200, y con reintentos cada 15
 * minutos el mismo evento llega varias veces. Guardar el `x-request-id` da dos
 * cosas: descartar el reproceso, y poder responder "qué llegó y cuándo" cuando
 * un cobro no cuadra —hoy un aviso perdido no dejaba ningún rastro.
 */

const COLLECTION = 'mercadoPagoWebhookEvents';
/** Ventana de deduplicado; después el TTL de Firestore borra el documento. */
const EVENT_TTL_HOURS = 72;

export interface WebhookEventInput {
    /** `x-request-id` de la notificación; es el identificador del envío. */
    requestId: string;
    type: string | null;
    dataId: string | null;
}

/**
 * Registra el evento. Devuelve `false` si ese envío ya se había procesado, para
 * que el llamador conteste 200 sin repetir el trabajo.
 */
export const registerWebhookEvent = async (input: WebhookEventInput): Promise<boolean> => {
    const timestamp = now();
    try {
        await db()
            .collection(COLLECTION)
            .doc(input.requestId)
            .create({
                requestId: input.requestId,
                type: input.type,
                dataId: input.dataId,
                receivedAt: timestamp,
                expiresAt: new Date(timestamp.toMillis() + EVENT_TTL_HOURS * 60 * 60 * 1000),
            });
        return true;
    } catch {
        return false;
    }
};

/** Deja constancia de cómo se resolvió el aviso; no es crítico si falla. */
export const markWebhookEventHandled = async (
    requestId: string,
    outcome: Record<string, unknown>,
): Promise<void> => {
    try {
        await db().collection(COLLECTION).doc(requestId).update({ outcome, handledAt: now() });
    } catch (error) {
        console.warn('No se pudo cerrar el evento de webhook en la bitácora', { requestId, error });
    }
};
