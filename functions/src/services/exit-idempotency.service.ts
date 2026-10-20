import { createHash } from 'crypto';
import { Batch, StockMovement } from '../types';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { db } from '../utils/firestore';
import * as batchesRepo from '../repositories/batches.repository';
import * as movementsRepo from '../repositories/stock-movements.repository';

/**
 * Idempotencia de las salidas de inventario (`POST /inventory/exits`), con el
 * patrón de las entradas: la pantalla genera una llave por captura y la reenvía
 * sin cambios al reintentar.
 *
 * Sin ella, una respuesta perdida tras una salida que **sí** se aplicó hacía que
 * el reintento descontara el lote otra vez, con una merma duplicada en la
 * bitácora. La llave es opcional para no romper a los clientes que aún no la
 * mandan.
 *
 * Comparte la colección (y la política TTL de 72 h) con las entradas; el alcance
 * `exit` va en el id para que la misma llave en otro endpoint no se confunda.
 */
const COLLECTION = 'stockEntryIdempotencyKeys';
const SCOPE = 'exit';
const TTL_HOURS = 72;
/** Código gRPC de `create()` sobre un documento que ya existe. */
const ALREADY_EXISTS = 6;

const isAlreadyExists = (error: unknown): boolean =>
    (error as { code?: number } | null)?.code === ALREADY_EXISTS;

export type ExitResult = { batch: Batch; movement: StockMovement };

export interface ExitContent {
    productId: string;
    batchId: string;
    quantity: number;
    reason: string;
    notes?: string;
}

/** Huella del contenido: una llave reutilizada con otra salida se detecta con ella. */
export const hashExitContent = (content: ExitContent): string =>
    createHash('sha256')
        .update(
            JSON.stringify([
                content.productId,
                content.batchId,
                content.quantity,
                content.reason,
                (content.notes ?? '').trim(),
            ]),
        )
        .digest('hex');

export const runIdempotentExit = async (input: {
    userId: string;
    key?: string;
    content: ExitContent;
    /**
     * La salida es una sola transacción: si lanza, no quedó nada escrito, así que
     * la llave se libera y el mismo intento corregido puede reutilizarla.
     */
    run: () => Promise<ExitResult>;
}): Promise<ExitResult> => {
    if (!input.key) {
        return input.run();
    }

    const contentHash = hashExitContent(input.content);
    const ref = db().collection(COLLECTION).doc(`${input.userId}:${SCOPE}:${input.key}`);

    try {
        // `create` falla si otro intento simultáneo ya la reservó: dos envíos en
        // paralelo no pueden descontar el lote dos veces.
        await ref.create({
            userId: input.userId,
            scope: SCOPE,
            contentHash,
            createdAt: new Date(),
            // Campo para la política TTL de Firestore sobre esta colección.
            expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
        });
    } catch (error) {
        if (!isAlreadyExists(error)) {
            throw error;
        }
        const data = (await ref.get()).data();
        if (data?.contentHash !== contentHash) {
            throw unprocessable(
                'Esta llave de idempotencia ya se usó con otra salida. ' +
                    'Genera una llave nueva para cada captura.',
            );
        }
        const movementId = data?.movementId as string | undefined;
        if (movementId) {
            const movement = await movementsRepo.getStockMovementById(movementId);
            const batch = await batchesRepo.getBatchById(input.content.batchId);
            if (!movement || !batch) {
                throw notFound('Salida de inventario');
            }
            // `batch` refleja el estado actual del lote, no el de la primera respuesta.
            return { batch, movement };
        }
        throw conflict(
            'Esta salida ya se está registrando o quedó a medias en un intento anterior. ' +
                'Revisa el inventario antes de volver a capturarla.',
        );
    }

    try {
        const result = await input.run();
        // Cierra la llave: de aquí en adelante el reintento devuelve esta salida.
        await ref.set({ movementId: result.movement.id }, { merge: true });
        return result;
    } catch (error) {
        await ref.delete().catch(() => undefined);
        throw error;
    }
};
