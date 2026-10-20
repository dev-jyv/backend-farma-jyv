import { InventoryEntryWithDetails } from '../types';
import { conflict } from '../utils/errors';
import { db } from '../utils/firestore';
import * as inventoryService from './inventory.service';

/**
 * Idempotencia de las entradas de inventario (`POST /inventory/entries` y
 * `/inventory/direct-entries`), con el mismo patrón que las ventas y que
 * `createStockEntry`: la pantalla genera una llave por captura y la reenvía sin
 * cambios en cada reintento.
 *
 * Sin ella, una respuesta perdida tras una entrada que **sí** se aplicó hacía que
 * el reintento sumara el stock otra vez: existencias que no existen y que nadie
 * cuadra contra la factura. La llave es opcional para no romper a los clientes
 * que aún no la mandan.
 */
const COLLECTION = 'stockEntryIdempotencyKeys';
const TTL_HOURS = 72;
/** Código gRPC de `create()` sobre un documento que ya existe. */
const ALREADY_EXISTS = 6;

export type EntryScope = 'invoice-entry' | 'direct-entry';

const isAlreadyExists = (error: unknown): boolean =>
    (error as { code?: number } | null)?.code === ALREADY_EXISTS;

export const runIdempotentEntry = async (input: {
    userId: string;
    scope: EntryScope;
    key?: string;
    /**
     * `true` cuando un fallo garantiza que no quedó nada escrito (la entrada se
     * guarda en una sola transacción), de modo que se puede liberar la llave y
     * dejar que el mismo intento corregido use la misma. Con efectos previos no
     * atómicos (alta de productos) se conserva y el reintento pide revisión.
     */
    releaseOnFailure: boolean;
    run: () => Promise<InventoryEntryWithDetails>;
}): Promise<InventoryEntryWithDetails> => {
    if (!input.key) {
        return input.run();
    }

    // El alcance va en el id: la misma llave en otro endpoint no debe devolver la
    // entrada de este.
    const ref = db()
        .collection(COLLECTION)
        .doc(`${input.userId}:${input.scope}:${input.key}`);

    try {
        // `create` falla si otro intento simultáneo ya la reservó: dos envíos en
        // paralelo no pueden aplicar la misma entrada dos veces.
        await ref.create({
            userId: input.userId,
            scope: input.scope,
            createdAt: new Date(),
            // Campo para la política TTL de Firestore sobre esta colección.
            expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
        });
    } catch (error) {
        if (!isAlreadyExists(error)) {
            throw error;
        }
        const entryId = (await ref.get()).data()?.entryId as string | undefined;
        if (entryId) {
            return inventoryService.getEntry(entryId);
        }
        throw conflict(
            'Esta entrada ya se está registrando o quedó a medias en un intento anterior. ' +
                'Revisa el inventario antes de volver a capturarla.',
        );
    }

    try {
        const entry = await input.run();
        // Cierra la llave: de aquí en adelante el reintento devuelve esta entrada.
        await ref.set({ entryId: entry.id }, { merge: true });
        return entry;
    } catch (error) {
        if (input.releaseOnFailure) {
            await ref.delete().catch(() => undefined);
        }
        throw error;
    }
};
