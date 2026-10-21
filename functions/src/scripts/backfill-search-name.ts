import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';
import { normalizeSearchName, SEARCH_NAME_FIELD } from '../utils/search-name';

/**
 * Rellena `searchName` (nombre en minúsculas sin acentos) en `customers`,
 * `patients`, `users` y `roles` (SPEC 10).
 *
 * ORDEN DE DESPLIEGUE: correr este backfill ANTES de desplegar la lectura por
 * prefijo. Un documento sin `searchName` no aparece en las búsquedas.
 *
 * Idempotente: solo escribe los documentos cuyo `searchName` falta o difiere.
 * Con `--dry-run` solo reporta cuántos faltan y no escribe nada.
 *
 * Uso:
 *   npm run backfill:search-name -- --dry-run
 *   npm run backfill:search-name -- --collection=customers
 *   npm run backfill:search-name -- --confirm-backup   (incluye `patients`)
 *
 * `patients` guarda datos clínicos: fuera de `--dry-run` el script se niega a
 * tocarla sin `--confirm-backup`, que afirma que ya existe un respaldo
 * (`gcloud firestore export gs://<bucket>/pre-search-name --collection-ids=patients`).
 *
 * Mismas credenciales que `backfill:denormalized`.
 */

const projectRoot = path.resolve(__dirname, '../../..');
const functionsDir = path.resolve(__dirname, '../..');

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

/** Credenciales de `gcloud auth application-default login`, si existen. */
const hasApplicationDefaultCredentials = (): boolean => {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const rutas = [
        process.env.CLOUDSDK_CONFIG
            ? path.join(process.env.CLOUDSDK_CONFIG, 'application_default_credentials.json')
            : null,
        home
            ? path.join(home, '.config', 'gcloud', 'application_default_credentials.json')
            : null,
        home
            ? path.join(home, 'AppData', 'Roaming', 'gcloud',
                'application_default_credentials.json')
            : null,
    ].filter((ruta): ruta is string => Boolean(ruta));

    return rutas.some((ruta) => fs.existsSync(ruta));
};

export const initAdmin = (): void => {
    if (admin.apps.length) {
        return;
    }

    const projectId = resolveProjectId();

    if (process.env.FIRESTORE_EMULATOR_HOST) {
        admin.initializeApp({ projectId });
        return;
    }

    const serviceAccountPath = resolveServiceAccountPath();
    if (serviceAccountPath) {
        const serviceAccount = JSON.parse(
            fs.readFileSync(serviceAccountPath, 'utf8'),
        ) as admin.ServiceAccount;
        admin.initializeApp({ projectId, credential: admin.credential.cert(serviceAccount) });
        return;
    }

    // Sin llave en disco se usan las credenciales por defecto de gcloud
    // (`gcloud auth application-default login`). Es el camino preferible: una
    // llave de servicio descargada es un secreto de vida larga que queda en el
    // equipo de quien corrió el script una vez, y que nadie rota después.
    if (hasApplicationDefaultCredentials()) {
        admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
        return;
    }

    throw new Error(
        'No hay credenciales locales. Corre `gcloud auth application-default login`, ' +
        'coloca service-account.json en la raíz del repo, define ' +
        'GOOGLE_APPLICATION_CREDENTIALS, o apunta FIRESTORE_EMULATOR_HOST al emulador.',
    );
};

export type Target = {
    collection: string;
    nameOf: (data: FirebaseFirestore.DocumentData) => string | null;
};

const asText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value : null;

export const TARGETS: Target[] = [
    { collection: 'customers', nameOf: (d) => asText(d.name) },
    {
        collection: 'patients',
        nameOf: (d) =>
            asText(`${d.firstName ?? ''} ${d.lastName ?? ''}`) ?? asText(d.fullName),
    },
    { collection: 'users', nameOf: (d) => asText(d.displayName) },
    { collection: 'roles', nameOf: (d) => asText(d.name) },
];

const PAGE_SIZE = 400;

export const backfillCollection = async (
    target: Target,
    dryRun: boolean,
): Promise<{ scanned: number; missing: number; written: number; noName: number }> => {
    const firestore = admin.firestore();
    const result = { scanned: 0, missing: 0, written: 0, noName: 0 };
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
            const name = target.nameOf(doc.data());
            if (name === null) {
                result.noName += 1;
                continue;
            }
            const expected = normalizeSearchName(name);
            if (doc.get(SEARCH_NAME_FIELD) === expected) {
                continue;
            }
            result.missing += 1;
            if (!dryRun) {
                batch.update(doc.ref, { [SEARCH_NAME_FIELD]: expected });
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
    const confirmedBackup = process.argv.includes('--confirm-backup');
    const only = process.argv
        .find((arg) => arg.startsWith('--collection='))
        ?.split('=')[1];

    const targets = TARGETS.filter((t) => !only || t.collection === only);
    if (targets.length === 0) {
        throw new Error(`Colección desconocida: ${only}`);
    }
    if (!dryRun && !confirmedBackup && targets.some((t) => t.collection === 'patients')) {
        throw new Error(
            'Escribir en `patients` exige --confirm-backup (respaldo previo con ' +
            '`gcloud firestore export`). Usa --dry-run para solo reportar, o ' +
            '--collection=<otra> para excluir pacientes.',
        );
    }

    initAdmin();

    for (const target of targets) {
        const r = await backfillCollection(target, dryRun);
        console.log(
            `${target.collection}: revisados=${r.scanned} sin/errónea searchName=${r.missing} ` +
            `sin nombre=${r.noName} escritos=${r.written}`,
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
