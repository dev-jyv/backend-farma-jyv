import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';

/**
 * Backfill de los campos denormalizados que solo existen en altas nuevas:
 *
 *  - `products.totalStock`            — suma de los lotes del producto.
 *  - `sales.productIds[]`             — ids de producto de la venta.
 *  - `inventoryEntries.productIds[]`  — ids de producto de la entrada.
 *  - `batches.supplierId`             — proveedor del lote, vía el movimiento de
 *                                        entrada que lo creó y su `inventoryEntry`.
 *
 * Es **idempotente**: por omisión solo escribe documentos a los que les falta el
 * campo. Con `--force` recalcula todos (útil si se sospecha divergencia).
 *
 * Uso:
 *   npm run backfill:denormalized -- --dry-run
 *   npm run backfill:denormalized
 *   npm run backfill:denormalized -- --force --only=products,batches
 *
 * Requiere credenciales locales (service-account.json o GOOGLE_APPLICATION_CREDENTIALS),
 * o `FIRESTORE_EMULATOR_HOST` apuntando al emulador.
 */

const projectRoot = path.resolve(__dirname, '../../..');
const functionsDir = path.resolve(__dirname, '../..');

/** Firestore acepta 500 operaciones por batch; se deja margen. */
const BATCH_LIMIT = 400;

type Target = 'products' | 'sales' | 'entries' | 'batches';
const ALL_TARGETS: Target[] = ['products', 'sales', 'entries', 'batches'];

interface Options {
    dryRun: boolean;
    force: boolean;
    targets: Target[];
}

const parseOptions = (argv: string[]): Options => {
    const onlyArg = argv.find((arg) => arg.startsWith('--only='));
    const requested = onlyArg
        ? onlyArg.slice('--only='.length).split(',').map((value) => value.trim())
        : [];

    const invalid = requested.filter((value) => !ALL_TARGETS.includes(value as Target));
    if (invalid.length) {
        throw new Error(
            `--only inválido: ${invalid.join(', ')}. Válidos: ${ALL_TARGETS.join(', ')}`,
        );
    }

    return {
        dryRun: argv.includes('--dry-run'),
        force: argv.includes('--force'),
        targets: requested.length ? (requested as Target[]) : ALL_TARGETS,
    };
};

const resolveProjectId = (): string => {
    const firebasercPath = path.join(projectRoot, '.firebaserc');
    const firebaserc = JSON.parse(fs.readFileSync(firebasercPath, 'utf8')) as {
        projects?: { default?: string };
    };
    const projectId = firebaserc.projects?.default;
    if (!projectId) {
        throw new Error('No se encontró projectId en .firebaserc');
    }
    return projectId;
};

const resolveServiceAccountPath = (): string | null => {
    const candidates = [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        path.join(projectRoot, 'service-account.json'),
        path.join(functionsDir, 'service-account.json'),
    ].filter((value): value is string => Boolean(value));

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

const initAdmin = (): void => {
    if (admin.apps.length) {
        return;
    }

    const projectId = resolveProjectId();

    if (process.env.FIRESTORE_EMULATOR_HOST) {
        admin.initializeApp({ projectId });
        return;
    }

    const serviceAccountPath = resolveServiceAccountPath();
    if (!serviceAccountPath) {
        throw new Error(
            'No hay credenciales locales. Coloca service-account.json en la raíz del repo, ' +
            'define GOOGLE_APPLICATION_CREDENTIALS, o apunta FIRESTORE_EMULATOR_HOST al emulador.',
        );
    }

    const serviceAccount = JSON.parse(
        fs.readFileSync(serviceAccountPath, 'utf8'),
    ) as admin.ServiceAccount;
    admin.initializeApp({ projectId, credential: admin.credential.cert(serviceAccount) });
};

interface Stats {
    scanned: number;
    updated: number;
    skipped: number;
}

const emptyStats = (): Stats => ({ scanned: 0, updated: 0, skipped: 0 });

/** Escribe por lotes; en dry-run solo cuenta. */
class BatchWriter {
    private batch: FirebaseFirestore.WriteBatch | null = null;

    private pending = 0;

    constructor(
        private readonly firestore: FirebaseFirestore.Firestore,
        private readonly dryRun: boolean,
    ) {}

    async update(
        ref: FirebaseFirestore.DocumentReference,
        data: FirebaseFirestore.UpdateData<Record<string, unknown>>,
    ): Promise<void> {
        if (this.dryRun) {
            return;
        }
        if (!this.batch) {
            this.batch = this.firestore.batch();
        }
        this.batch.update(ref, data);
        this.pending += 1;
        if (this.pending >= BATCH_LIMIT) {
            await this.flush();
        }
    }

    async flush(): Promise<void> {
        if (!this.batch || this.pending === 0) {
            return;
        }
        await this.batch.commit();
        this.batch = null;
        this.pending = 0;
    }
}

const backfillProductTotalStock = async (
    firestore: FirebaseFirestore.Firestore,
    options: Options,
): Promise<Stats> => {
    const stats = emptyStats();
    const writer = new BatchWriter(firestore, options.dryRun);

    // Un solo barrido de lotes: acumular en memoria es más barato que N consultas.
    const stockByProduct = new Map<string, number>();
    const batches = await firestore.collection('batches').get();
    for (const doc of batches.docs) {
        const productId = doc.data().productId as string | undefined;
        if (!productId) {
            continue;
        }
        stockByProduct.set(
            productId,
            (stockByProduct.get(productId) ?? 0) + ((doc.data().quantity as number) ?? 0),
        );
    }

    const products = await firestore.collection('products').get();
    for (const doc of products.docs) {
        stats.scanned += 1;
        const current = doc.data().totalStock as number | undefined;
        const computed = stockByProduct.get(doc.id) ?? 0;

        if (!options.force && current !== undefined) {
            stats.skipped += 1;
            continue;
        }
        if (current === computed) {
            stats.skipped += 1;
            continue;
        }

        await writer.update(doc.ref, { totalStock: computed });
        stats.updated += 1;
    }

    await writer.flush();
    return stats;
};

/** `sales` e `inventoryEntries` comparten forma: items[] con productId. */
const backfillProductIds = async (
    firestore: FirebaseFirestore.Firestore,
    collectionName: 'sales' | 'inventoryEntries',
    options: Options,
): Promise<Stats> => {
    const stats = emptyStats();
    const writer = new BatchWriter(firestore, options.dryRun);
    const snapshot = await firestore.collection(collectionName).get();

    for (const doc of snapshot.docs) {
        stats.scanned += 1;
        const data = doc.data();
        const existing = data.productIds as string[] | undefined;

        if (!options.force && existing?.length) {
            stats.skipped += 1;
            continue;
        }

        const items = (data.items as Array<{ productId?: string }> | undefined) ?? [];
        const productIds = [...new Set(
            items.map((item) => item.productId).filter((id): id is string => Boolean(id)),
        )];

        if (!productIds.length) {
            stats.skipped += 1;
            continue;
        }

        await writer.update(doc.ref, { productIds });
        stats.updated += 1;
    }

    await writer.flush();
    return stats;
};

const backfillBatchSupplier = async (
    firestore: FirebaseFirestore.Firestore,
    options: Options,
): Promise<Stats> => {
    const stats = emptyStats();
    const writer = new BatchWriter(firestore, options.dryRun);

    // batchId -> entryId, vía el movimiento de entrada que creó el lote.
    const entryIdByBatch = new Map<string, string>();
    const movements = await firestore
        .collection('stockMovements')
        .where('type', '==', 'entry')
        .get();
    for (const doc of movements.docs) {
        const batchId = doc.data().batchId as string | undefined;
        const referenceId = doc.data().referenceId as string | undefined;
        if (batchId && referenceId && !entryIdByBatch.has(batchId)) {
            entryIdByBatch.set(batchId, referenceId);
        }
    }

    const entries = await firestore.collection('inventoryEntries').get();
    const supplierByEntry = new Map<string, string>();
    for (const doc of entries.docs) {
        const supplierId = doc.data().supplierId as string | undefined;
        if (supplierId) {
            supplierByEntry.set(doc.id, supplierId);
        }
    }

    const batches = await firestore.collection('batches').get();
    for (const doc of batches.docs) {
        stats.scanned += 1;
        if (!options.force && doc.data().supplierId) {
            stats.skipped += 1;
            continue;
        }

        const entryId = entryIdByBatch.get(doc.id);
        const supplierId = entryId ? supplierByEntry.get(entryId) : undefined;
        if (!supplierId) {
            // Lote sin entrada rastreable (carga manual o dato viejo): se deja igual.
            stats.skipped += 1;
            continue;
        }

        await writer.update(doc.ref, { supplierId });
        stats.updated += 1;
    }

    await writer.flush();
    return stats;
};

const run = async (): Promise<void> => {
    const options = parseOptions(process.argv.slice(2));
    initAdmin();
    const firestore = admin.firestore();

    console.log(
        `Backfill ${options.dryRun ? '(dry-run) ' : ''}` +
        `objetivos: ${options.targets.join(', ')}${options.force ? ' [force]' : ''}`,
    );

    const results: Array<[string, Stats]> = [];

    if (options.targets.includes('products')) {
        results.push(['products.totalStock', await backfillProductTotalStock(firestore, options)]);
    }
    if (options.targets.includes('sales')) {
        results.push(['sales.productIds', await backfillProductIds(firestore, 'sales', options)]);
    }
    if (options.targets.includes('entries')) {
        results.push([
            'inventoryEntries.productIds',
            await backfillProductIds(firestore, 'inventoryEntries', options),
        ]);
    }
    if (options.targets.includes('batches')) {
        results.push(['batches.supplierId', await backfillBatchSupplier(firestore, options)]);
    }

    for (const [label, stats] of results) {
        console.log(
            `${label}: ${stats.updated} actualizados, ${stats.skipped} sin cambio, ` +
            `${stats.scanned} revisados`,
        );
    }

    if (options.dryRun) {
        console.log('Dry-run: no se escribió nada.');
    }
};

run()
    .then(() => {
        console.log('Backfill completado');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error en el backfill:', error);
        process.exit(1);
    });
