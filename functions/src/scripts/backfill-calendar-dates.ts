import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { isLegacyMidnight, shiftToNoon } from '../utils/calendar-date';
import { initAdmin } from './backfill-search-name';

/**
 * Pasa las fechas de calendario guardadas a medianoche UTC al mediodía UTC
 * (SPEC 18): `invoices.invoiceDate`, `invoices.dueDate`, `batches.expiryDate` e
 * `inventoryEntries.items[].expiryDate`.
 *
 * ORDEN DE DESPLIEGUE: desplegar primero el código (escribe a mediodía y busca
 * lotes en ambas representaciones) y DESPUÉS correr este backfill, con respaldo
 * previo de las tres colecciones:
 *
 *   gcloud firestore export gs://<bucket>/pre-calendar-dates \
 *     --collection-ids=invoices,batches,inventoryEntries
 *
 * Idempotente: solo toca los valores que están exactamente a las 00:00:00.000Z
 * (los ya corregidos y los que llevan hora real se dejan). Con `--dry-run` solo
 * reporta cuántos documentos y campos corregiría.
 *
 * Uso:
 *   npm run backfill:calendar-dates -- --dry-run
 *   npm run backfill:calendar-dates
 *   npm run backfill:calendar-dates -- --collection=batches
 *
 * Mismas credenciales que `backfill:denormalized`.
 */

type Updates = FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>;
type Plan = { updates: Updates; fields: number } | null;

export type Target = {
    collection: string;
    plan: (data: FirebaseFirestore.DocumentData) => Plan;
};

const isStamp = (value: unknown): value is Timestamp =>
    !!value &&
    typeof (value as Timestamp).toMillis === 'function' &&
    typeof (value as Timestamp).nanoseconds === 'number';

const shiftable = (value: unknown): value is Timestamp =>
    isStamp(value) && value.nanoseconds === 0 && isLegacyMidnight(value);

const topLevel = (fields: string[]) => (data: FirebaseFirestore.DocumentData): Plan => {
    const updates: Updates = {};
    for (const field of fields) {
        const value = data[field];
        if (shiftable(value)) {
            updates[field] = shiftToNoon(value);
        }
    }
    const count = Object.keys(updates).length;
    return count > 0 ? { updates, fields: count } : null;
};

export const TARGETS: Target[] = [
    { collection: 'invoices', plan: topLevel(['invoiceDate', 'dueDate']) },
    { collection: 'batches', plan: topLevel(['expiryDate']) },
    {
        collection: 'inventoryEntries',
        plan: (data) => {
            const items = data.items;
            if (!Array.isArray(items)) {
                return null;
            }
            let fields = 0;
            const shifted = items.map((item: Record<string, unknown>) => {
                if (shiftable(item?.expiryDate)) {
                    fields += 1;
                    return { ...item, expiryDate: shiftToNoon(item.expiryDate) };
                }
                return item;
            });
            return fields > 0 ? { updates: { items: shifted }, fields } : null;
        },
    },
];

const PAGE_SIZE = 400;

export const backfillCollection = async (
    target: Target,
    dryRun: boolean,
): Promise<{ scanned: number; documents: number; fields: number; written: number }> => {
    const firestore = admin.firestore();
    const result = { scanned: 0, documents: 0, fields: 0, written: 0 };
    let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;

    for (;;) {
        let query = firestore
            .collection(target.collection)
            .orderBy(admin.firestore.FieldPath.documentId())
            .limit(PAGE_SIZE);
        if (last) {
            query = query.startAfter(last);
        }
        const snapshot = await query.get();
        if (snapshot.empty) {
            break;
        }

        const batch = firestore.batch();
        let pending = 0;
        for (const doc of snapshot.docs) {
            result.scanned += 1;
            const plan = target.plan(doc.data());
            if (!plan) {
                continue;
            }
            result.documents += 1;
            result.fields += plan.fields;
            if (!dryRun) {
                batch.update(doc.ref, plan.updates);
                pending += 1;
            }
        }
        if (pending > 0) {
            await batch.commit();
            result.written += pending;
        }
        last = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < PAGE_SIZE) {
            break;
        }
    }
    return result;
};

const main = async (): Promise<void> => {
    const dryRun = process.argv.includes('--dry-run');
    const only = process.argv.find((arg) => arg.startsWith('--collection='))?.split('=')[1];

    const targets = TARGETS.filter((t) => !only || t.collection === only);
    if (targets.length === 0) {
        throw new Error(`Colección desconocida: ${only}`);
    }

    initAdmin();

    for (const target of targets) {
        const r = await backfillCollection(target, dryRun);
        console.log(
            `${target.collection}: revisados=${r.scanned} documentos a corregir=${r.documents} ` +
            `campos=${r.fields} escritos=${r.written}`,
        );
    }
    console.log(dryRun ? 'Dry-run: no se escribió nada.' : 'Backfill terminado.');
};

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
