import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';

/**
 * Reconstruye `dailyStats` (agregado diario de ventas) desde las ventas.
 *
 * Idempotente: solo escribe los días cuyo agregado difiere de lo que dicen las
 * ventas. Con `--dry-run` (o `--verify`) solo reporta las diferencias; sirve
 * también para comprobar que las transacciones mantienen el agregado fiel.
 *
 * Uso:
 *   npm run backfill:daily-stats -- --dry-run
 *   npm run backfill:daily-stats
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


const main = async (): Promise<void> => {
    const verifyOnly = process.argv.includes('--dry-run') || process.argv.includes('--verify');
    initAdmin();

    // Import tardío: los módulos leen la app de admin al cargarse.
    const { diffDailyStats, rebuildDailyStats } = await import('../services/daily-stats.service');

    const diffs = await diffDailyStats();
    for (const diff of diffs) {
        const stored = JSON.stringify(diff.stored);
        const expected = JSON.stringify(diff.expected);
        console.log(`${diff.ymd}: guardado=${stored} esperado=${expected}`);
    }
    console.log(`Días con diferencia: ${diffs.length}`);

    if (verifyOnly) {
        console.log('Dry-run: no se escribió nada.');
        return;
    }
    const written = await rebuildDailyStats();
    console.log(`Días reescritos: ${written}`);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
