import { createHash } from 'crypto';
import { BulkCreateEntriesResult, InventoryEntryWithDetails } from '../types';
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

export type BulkEntryGroupInput = Parameters<typeof inventoryService.bulkCreateEntries>[0][number];

/** JSON canónico: llaves ordenadas, sin `undefined`, para que el hash no dependa del orden. */
const canonical = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
};

/** Huella del contenido del grupo; reordenar sus ítems no la cambia. */
export const hashEntryGroup = (group: BulkEntryGroupInput): string => {
    const items = group.items.map(canonical).sort();
    return createHash('sha256')
        .update(
            canonical({
                invoiceId: group.invoiceId,
                supplierId: group.supplierId,
                notes: group.notes,
                items,
            }),
        )
        .digest('hex');
};

/**
 * Carga masiva con llave: cada grupo usa `sha256(<llave>:<hash del grupo>)` como
 * llave propia, así un reintento (o el archivo corregido y re-subido completo)
 * no vuelve a aplicar los grupos ya registrados. Sin llave, igual que antes.
 */
export const bulkCreateEntriesIdempotent = async (input: {
    userId: string;
    key?: string;
    entries: BulkEntryGroupInput[];
}): Promise<BulkCreateEntriesResult> => {
    if (!input.key) {
        return inventoryService.bulkCreateEntries(input.entries, input.userId);
    }

    const created: InventoryEntryWithDetails[] = [];
    const errors: BulkCreateEntriesResult['errors'] = [];
    // Dos grupos idénticos en la misma carga son dos entradas distintas: se
    // distinguen por su número de ocurrencia (la primera conserva el hash base).
    const seen = new Map<string, number>();

    for (let index = 0; index < input.entries.length; index++) {
        const group = input.entries[index];
        const base = hashEntryGroup(group);
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        const groupHash = occurrence === 0 ? base : `${base}#${occurrence}`;
        const key = createHash('sha256').update(`${input.key}:${groupHash}`).digest('hex');

        try {
            const entry = await runIdempotentEntry({
                userId: input.userId,
                scope: group.invoiceId ? 'invoice-entry' : 'direct-entry',
                key,
                // Los grupos masivos solo traen productId (sin alta inline): un
                // fallo no deja nada escrito, se libera la llave para reintentar.
                releaseOnFailure: !group.items.some(
                    (item) => (item as { product?: unknown }).product,
                ),
                run: () =>
                    group.invoiceId
                        ? inventoryService.recordEntry({
                            invoiceId: group.invoiceId,
                            items: group.items,
                            userId: input.userId,
                        })
                        : inventoryService.recordDirectEntry({
                            supplierId: group.supplierId!,
                            notes: group.notes,
                            items: group.items,
                            userId: input.userId,
                        }),
            });
            created.push(entry);
        } catch (error) {
            errors.push({
                index,
                message: error instanceof Error ? error.message : 'No se pudo registrar la entrada',
            });
        }
    }

    return { created, errors };
};
