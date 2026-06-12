import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as admin from 'firebase-admin';
import { migrateUsersToRoleIds, seedSystemRoles } from '../services/roles.service';

const projectRoot = path.resolve(__dirname, '../../..');
const functionsDir = path.resolve(__dirname, '../..');

const parseEnvFile = (filePath: string): Record<string, string> => {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .reduce<Record<string, string>>((env, line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return env;
            }

            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex === -1) {
                return env;
            }

            const key = trimmed.slice(0, separatorIndex).trim();
            const value = trimmed.slice(separatorIndex + 1).trim();
            env[key] = value;
            return env;
        }, {});
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

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
};

const resolveApiUrl = (env: Record<string, string>): string => {
    if (env.API_URL) {
        return env.API_URL.replace(/\/$/, '');
    }

    try {
        const output = execSync('firebase functions:list --json', {
            encoding: 'utf8',
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const parsed = JSON.parse(output) as {
            result?: Array<{ id?: string; uri?: string }>;
        };
        const api = parsed.result?.find((item) => item.id === 'api');
        if (api?.uri) {
            return api.uri.replace(/\/$/, '');
        }
    } catch {
        return '';
    }

    return '';
};

const initLocalAdmin = (): void => {
    const serviceAccountPath = resolveServiceAccountPath();
    if (!serviceAccountPath) {
        throw new Error('NO_LOCAL_CREDENTIALS');
    }

    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')) as admin.ServiceAccount;

    if (!admin.apps.length) {
        admin.initializeApp({
            projectId: resolveProjectId(),
            credential: admin.credential.cert(serviceAccount),
        });
    }
};

const runLocalMigration = async (): Promise<void> => {
    console.log('Sembrando roles del sistema...');
    const roleIds = await seedSystemRoles();
    console.log('Roles creados:', roleIds);

    console.log('Migrando usuarios...');
    const migrated = await migrateUsersToRoleIds(roleIds);
    console.log(`Usuarios migrados: ${migrated}`);
};

const runRemoteMigration = async (): Promise<void> => {
    const env = parseEnvFile(path.join(functionsDir, '.env'));
    const secret = process.env.MIGRATE_SECRET ?? env.MIGRATE_SECRET;
    const apiUrl = resolveApiUrl(env);

    if (!secret) {
        throw new Error('NO_MIGRATE_SECRET');
    }

    if (!apiUrl) {
        throw new Error('NO_API_URL');
    }

    console.log(`Ejecutando migración remota en ${apiUrl}...`);

    const response = await fetch(`${apiUrl}/v1/internal/migrate-roles`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-migrate-secret': secret,
        },
    });

    const body = await response.json() as {
        data?: { roleIds: Record<string, string>; migrated: number };
        error?: { message?: string };
    };

    if (!response.ok) {
        throw new Error(body.error?.message ?? `Migración remota falló (${response.status})`);
    }

    console.log('Roles creados:', body.data?.roleIds);
    console.log(`Usuarios migrados: ${body.data?.migrated ?? 0}`);
};

const printSetupHelp = (reason: string): void => {
    console.error('\nNo se pudo ejecutar la migración local ni remota.\n');

    if (reason === 'NO_LOCAL_CREDENTIALS') {
        console.error('Opción A - Service account local:');
        console.error('1. Firebase Console > Configuración del proyecto > Cuentas de servicio');
        console.error('2. Generar nueva clave privada y guardarla como service-account.json en la raíz del repo');
        console.error('3. Ejecutar de nuevo: npm run migrate:roles\n');
    }

    if (reason === 'NO_MIGRATE_SECRET' || reason === 'NO_LOCAL_CREDENTIALS') {
        console.error('Opción B - Migración remota:');
        console.error('1. Agrega MIGRATE_SECRET en functions/.env');
        console.error('2. Despliega: npm run deploy');
        console.error('3. Ejecuta: npm run migrate:roles\n');
    }

    if (reason === 'NO_API_URL') {
        console.error('Agrega API_URL en functions/.env o verifica que firebase CLI esté autenticado.');
    }
};

const run = async (): Promise<void> => {
    const serviceAccountPath = resolveServiceAccountPath();

    if (serviceAccountPath) {
        initLocalAdmin();
        await runLocalMigration();
        return;
    }

    try {
        await runRemoteMigration();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'UNKNOWN';
        if (message === 'NO_MIGRATE_SECRET' || message === 'NO_API_URL') {
            printSetupHelp(message);
            throw error;
        }
        printSetupHelp('NO_LOCAL_CREDENTIALS');
        throw error;
    }
};

run()
    .then(() => {
        console.log('Migración completada');
        process.exit(0);
    })
    .catch((error) => {
        if (error instanceof Error && error.message === 'NO_MIGRATE_SECRET') {
            process.exit(1);
        }
        if (error instanceof Error && error.message === 'NO_API_URL') {
            process.exit(1);
        }
        console.error('Error en migración:', error);
        process.exit(1);
    });
