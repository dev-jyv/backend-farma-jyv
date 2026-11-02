/**
 * SPEC 35 — credenciales en Secret Manager.
 *
 * Se fija:
 * - qué secretos monta cada función (`api` los siete; las programadas que mandan
 *   correo, solo Resend; las demás, ninguno): montar de más amplía lo que una
 *   función comprometida puede leer, montar de menos la deja rota en silencio;
 * - que el valor se lee en tiempo de ejecución desde la variable que Firebase
 *   monta, de modo que una prueba lo inyecta con `process.env`;
 * - que un valor en blanco cuenta como "no configurado" (el espacio reservado de
 *   `MERCADOPAGO_WEBHOOK_SECRET` y el `" "` de `.secret.local`), con la misma
 *   degradación de antes: R2 cae a `uploads/`, el webhook sin firma se rechaza
 *   en producción;
 * - que `check-env-split.mjs` rechaza los siete en un `.env` desplegable y
 *   `ensure-secret-local.mjs` deja el emulador sin ir a Secret Manager.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    getMercadoPagoWebhookSecret,
    getMigrateSecret,
    getOpenRouterApiKey,
    getR2Config,
} from '../src/config/env';
import { API_SECRETS, EMAIL_SECRETS } from '../src/config/secrets';
import { verifyWebhookSignature } from '../src/services/mercado-pago.service';
import { invoicePrefix } from '../src/utils/storage';

const SIETE = [
    'MERCADOPAGO_ACCESS_TOKEN',
    'MERCADOPAGO_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'MIGRATE_SECRET',
    'OPENROUTER_API_KEY',
];

const functionsDir = join(__dirname, '..');

const conEntorno = <T>(valores: Record<string, string | undefined>, trabajo: () => T): T => {
    const previo = { ...process.env };
    for (const [clave, valor] of Object.entries(valores)) {
        if (valor === undefined) {
            delete process.env[clave];
        } else {
            process.env[clave] = valor;
        }
    }
    try {
        return trabajo();
    } finally {
        process.env = previo;
    }
};

const secretosDe = (fn: unknown): string[] =>
    ((fn as { __endpoint: { secretEnvironmentVariables?: { key: string }[] } }).__endpoint
        .secretEnvironmentVariables ?? []).map((s) => s.key);

describe('declaración y montaje', () => {
    it('declara los siete secretos una sola vez', () => {
        const fuente = readFileSync(join(functionsDir, 'src/config/secrets.ts'), 'utf8');
        const declarados = [...fuente.matchAll(/defineSecret\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]);
        expect(declarados.sort()).toEqual([...SIETE].sort());
        expect(API_SECRETS.map((s) => s.name).sort()).toEqual([...SIETE].sort());
        expect(EMAIL_SECRETS.map((s) => s.name)).toEqual(['RESEND_API_KEY']);
    });

    it('cada función monta solo lo que usa', async () => {
        const index = await import('../src/index');
        expect(secretosDe(index.api).sort()).toEqual([...SIETE].sort());
        for (const programada of [
            index.dailySalesReport,
            index.monthlySalesReport,
            index.dailyInventoryAlerts,
            index.dailyPromotionsMaintenance,
        ]) {
            expect(secretosDe(programada)).toEqual(['RESEND_API_KEY']);
        }
        expect(secretosDe(index.dailyFirestoreBackup)).toEqual([]);
        expect(secretosDe(index.dailyStatsIntegrityCheck)).toEqual([]);
    });
});

describe('lectura en tiempo de ejecución', () => {
    it('lee el valor inyectado y lo recorta', () => {
        conEntorno({ MIGRATE_SECRET: '  valor-de-prueba\n', OPENROUTER_API_KEY: 'sk-or-x' }, () => {
            expect(getMigrateSecret()).toBe('valor-de-prueba');
            expect(getOpenRouterApiKey()).toBe('sk-or-x');
        });
    });

    it('sin variable o en blanco cuenta como no configurado', () => {
        conEntorno({ MIGRATE_SECRET: undefined, OPENROUTER_API_KEY: ' ' }, () => {
            expect(getMigrateSecret()).toBeNull();
            expect(getOpenRouterApiKey()).toBeNull();
        });
    });

    it('R2 sin las dos llaves cae a uploads/ como antes', () => {
        conEntorno(
            {
                R2_ACCOUNT_ID: 'cuenta',
                R2_BUCKET: 'bucket',
                R2_ACCESS_KEY_ID: ' ',
                R2_SECRET_ACCESS_KEY: undefined,
            },
            () => {
                expect(getR2Config()).toBeNull();
                expect(invoicePrefix()).toBe('uploads/');
            },
        );
        conEntorno(
            {
                R2_ACCOUNT_ID: 'cuenta',
                R2_BUCKET: 'bucket',
                R2_ACCESS_KEY_ID: 'llave',
                R2_SECRET_ACCESS_KEY: 'secreto',
            },
            () => {
                expect(getR2Config()?.endpoint).toBe('https://cuenta.r2.cloudflarestorage.com');
                expect(invoicePrefix()).toBe('facturas/');
            },
        );
    });

    it('el espacio reservado en blanco del webhook se rechaza en producción', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            conEntorno(
                {
                    MERCADOPAGO_WEBHOOK_SECRET: ' ',
                    K_SERVICE: 'api',
                    FUNCTIONS_EMULATOR: undefined,
                },
                () => {
                    expect(getMercadoPagoWebhookSecret()).toBeNull();
                    expect(() => verifyWebhookSignature({ dataId: 'ORD1' })).toThrow();
                },
            );
        } finally {
            error.mockRestore();
        }
    });
});

describe('scripts locales', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'secretos-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const checkEnvSplit = () =>
        spawnSync(process.execPath, [join(functionsDir, 'scripts/check-env-split.mjs'), dir], {
            encoding: 'utf8',
        });

    it('check-env-split rechaza un .env con RESEND_API_KEY sin imprimir el valor', () => {
        writeFileSync(join(dir, '.env'), 'CORS_ORIGINS=x\nRESEND_API_KEY=re_valor_secreto\n');
        const resultado = checkEnvSplit();
        expect(resultado.status).toBe(1);
        expect(resultado.stderr).toContain('RESEND_API_KEY');
        expect(resultado.stderr).not.toContain('re_valor_secreto');
    });

    it('check-env-split rechaza los siete en un .env.<proyecto>, aun vacíos', () => {
        writeFileSync(
            join(dir, '.env.farma-jyv-dev'),
            'R2_BUCKET=b\nR2_SECRET_ACCESS_KEY=\nMIGRATE_SECRET=x\n',
        );
        const resultado = checkEnvSplit();
        expect(resultado.status).toBe(1);
        expect(resultado.stderr).toContain('R2_SECRET_ACCESS_KEY');
        expect(resultado.stderr).toContain('MIGRATE_SECRET');
        expect(resultado.stderr).not.toContain('R2_BUCKET');
    });

    it('check-env-split acepta lo local, las plantillas y lo no secreto', () => {
        writeFileSync(join(dir, '.env'), 'CORS_ORIGINS=x\nR2_ACCOUNT_ID=cuenta\n');
        writeFileSync(join(dir, '.env.farma-jyv'), 'REPORTS_EMAIL_TO=a@b.c\n');
        writeFileSync(join(dir, '.env.local'), 'MIGRATE_SECRET=local-dev-secret\n');
        writeFileSync(join(dir, '.secret.local'), 'RESEND_API_KEY=" "\n');
        writeFileSync(join(dir, '.env.demo-farmajyv'), 'OPENROUTER_API_KEY=x\n');
        writeFileSync(join(dir, '.env.farma-jyv-dev.example'), 'RESEND_API_KEY=\n');
        expect(checkEnvSplit().status).toBe(0);
    });

    it('ensure-secret-local completa los siete sin pisar lo que ya hay', () => {
        writeFileSync(join(dir, '.env.local'), 'MIGRATE_SECRET=local-dev-secret\n');
        writeFileSync(
            join(dir, '.secret.local'),
            'OPENROUTER_API_KEY=sk-propio\nRESEND_API_KEY=\n',
        );
        const correr = () =>
            spawnSync(
                process.execPath,
                [join(functionsDir, 'scripts/ensure-secret-local.mjs'), dir],
                { encoding: 'utf8' },
            );

        const primera = correr();
        expect(primera.status).toBe(0);
        expect(primera.stdout).not.toContain('local-dev-secret');

        const contenido = readFileSync(join(dir, '.secret.local'), 'utf8');
        const lineas = contenido.split('\n').filter((l) => /^[A-Z]/.test(l));
        expect(lineas.map((l) => l.split('=')[0]).sort()).toEqual([...SIETE].sort());
        expect(contenido).toContain('OPENROUTER_API_KEY=sk-propio');
        expect(contenido).toContain('MIGRATE_SECRET=local-dev-secret');
        expect(contenido).toContain('RESEND_API_KEY=" "');
        expect(contenido).toContain('R2_ACCESS_KEY_ID=" "');

        // Idempotente: la segunda corrida no cambia nada.
        expect(correr().stdout).toBe('');
        expect(readFileSync(join(dir, '.secret.local'), 'utf8')).toBe(contenido);
    });

    it('ensure-secret-local parte de la plantilla cuando no hay nada', () => {
        const resultado = spawnSync(
            process.execPath,
            [join(functionsDir, 'scripts/ensure-secret-local.mjs'), dir],
            { encoding: 'utf8' },
        );
        expect(resultado.status).toBe(0);
        const contenido = readFileSync(join(dir, '.secret.local'), 'utf8');
        expect(contenido).toContain('MIGRATE_SECRET=local-dev-secret');
        expect(contenido).toContain('MERCADOPAGO_ACCESS_TOKEN=" "');
        const claves = contenido
            .split('\n')
            .filter((l) => /^[A-Z]/.test(l))
            .map((l) => l.split('=')[0]);
        expect(claves.sort()).toEqual([...SIETE].sort());
    });
});
