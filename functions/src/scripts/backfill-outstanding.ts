import * as admin from 'firebase-admin';
import { isAccruedOutstanding } from '../repositories/accrued-expenses.repository';
import { isOutstanding } from '../repositories/invoices.repository';
import { initAdmin } from './backfill-search-name';

/**
 * Rellena el marcador `outstanding` (SPEC 13) en `invoices` y `accruedExpenses`.
 *
 * ORDEN DE DESPLIEGUE: correr este backfill ANTES de desplegar la lectura que
 * filtra por `outstanding`. Un documento con saldo pero sin el marcador no
 * aparece en cuentas por pagar ni en el pasivo del balance.
 *
 * Idempotente: solo escribe los documentos cuyo marcador falta o difiere. Las
 * facturas `legacy` (sin `paidTotal`) se dejan sin marcador: se dan por saldadas.
 * Con `--dry-run` solo reporta y no escribe nada.
 *
 * Uso:
 *   npm run backfill:outstanding -- --dry-run
 *   npm run backfill:outstanding
 *   npm run backfill:outstanding -- --collection=invoices
 *
 * Mismas credenciales que `backfill:denormalized`.
 */

export type Target = {
    collection: string;
    /** `null` = el documento no lleva marcador (factura `legacy`). */
    expected: (data: FirebaseFirestore.DocumentData) => boolean | null;
};

const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

export const TARGETS: Target[] = [
    {
        collection: 'invoices',
        expected: (d) => {
            const total = num(d.totalAmount);
            const paid = num(d.paidTotal);
            return total === null || paid === null ? null : isOutstanding(total, paid);
        },
    },
    {
        collection: 'accruedExpenses',
        expected: (d) => {
            const amount = num(d.amount);
            return amount === null ? null : isAccruedOutstanding(amount, num(d.paidTotal) ?? 0);
        },
    },
];

const PAGE_SIZE = 400;

export const backfillCollection = async (
    target: Target,
    dryRun: boolean,
): Promise<{ scanned: number; missing: number; written: number; skipped: number }> => {
    const firestore = admin.firestore();
    const result = { scanned: 0, missing: 0, written: 0, skipped: 0 };
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
            const expected = target.expected(doc.data());
            if (expected === null) {
                result.skipped += 1;
                continue;
            }
            if (doc.get('outstanding') === expected) {
                continue;
            }
            result.missing += 1;
            if (!dryRun) {
                batch.update(doc.ref, { outstanding: expected });
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
            `${target.collection}: revisados=${r.scanned} sin/errónea marca=${r.missing} ` +
            `sin control de saldo=${r.skipped} escritos=${r.written}`,
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
