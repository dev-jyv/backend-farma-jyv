import * as fs from 'fs';
import * as path from 'path';
import * as logger from 'firebase-functions/logger';
import { runScheduledJob, SCHEDULED_JOB_EVENT } from '../src/schedules/scheduled-job';

/**
 * Las alertas de SPEC 32 (fallo definitivo y ausencia de `dailyFirestoreBackup`)
 * cuentan entradas `scheduled_job.finished` por `job` y `outcome`. Si este log
 * deja de salir o cambia de forma, las políticas se quedan mudas sin que nada
 * falle: de ahí estas pruebas.
 */

// Las exportaciones del logger no son reasignables (`jest.spyOn` falla): se
// sustituyen solo `info` y `warn`, que es lo que escribe `monitoredJob`.
jest.mock('firebase-functions/logger', () => ({
    ...jest.requireActual('firebase-functions/logger'),
    info: jest.fn(),
    warn: jest.fn(),
}));

jest.mock('@google-cloud/firestore', () => {
    const exportDocuments = jest.fn(async () => [{ name: 'operations/op-123' }]);
    class FirestoreAdminClient {
        databasePath(project: string, database: string) {
            return `projects/${project}/databases/${database}`;
        }
        exportDocuments = exportDocuments;
    }
    return { v1: { FirestoreAdminClient }, __exportDocuments: exportDocuments };
});

const scheduledEvent = { scheduleTime: '2026-11-02T08:00:00Z' } as never;

const info = logger.info as jest.Mock;
const warn = logger.warn as jest.Mock;

describe('runScheduledJob', () => {
    beforeEach(() => jest.clearAllMocks());

    it('deja un succeeded con el nombre de la función y el detalle de la tarea', async () => {
        await runScheduledJob('dailySalesReport', async () => ({ date: '2026-11-01' }));

        expect(warn).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][1]).toMatchObject({
            event: SCHEDULED_JOB_EVENT,
            job: 'dailySalesReport',
            outcome: 'succeeded',
            date: '2026-11-01',
        });
    });

    it('el detalle de la tarea no puede pisar las etiquetas de la métrica', async () => {
        await runScheduledJob('dailySalesReport', async () => ({
            job: 'otro',
            outcome: 'failed',
        }));

        expect(info.mock.calls[0][1]).toMatchObject({
            job: 'dailySalesReport',
            outcome: 'succeeded',
        });
    });

    it('un fallo deja un failed y relanza el error para que Scheduler reintente', async () => {
        const failure = new Error('bucket inválido');

        await expect(
            runScheduledJob('dailyInventoryAlerts', async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);

        expect(info).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toMatchObject({
            event: SCHEDULED_JOB_EVENT,
            job: 'dailyInventoryAlerts',
            outcome: 'failed',
            error: 'bucket inválido',
        });
    });
});

describe('dailyFirestoreBackup: log de ejecución', () => {
    const originalBucket = process.env.FIRESTORE_BACKUP_BUCKET;
    const originalProject = process.env.GCLOUD_PROJECT;
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        process.env.GCLOUD_PROJECT = 'demo-backup';
    });
    afterEach(() => {
        jest.restoreAllMocks();
        process.env.FIRESTORE_BACKUP_BUCKET = originalBucket;
        process.env.GCLOUD_PROJECT = originalProject;
        if (originalBucket === undefined) delete process.env.FIRESTORE_BACKUP_BUCKET;
        if (originalProject === undefined) delete process.env.GCLOUD_PROJECT;
    });

    it('al lanzar el export deja el succeeded que vigila la alerta de ausencia', async () => {
        process.env.FIRESTORE_BACKUP_BUCKET = 'gs://respaldos-prueba/';
        const { dailyFirestoreBackup } = await import('../src/schedules/backup.schedule');

        await dailyFirestoreBackup.run(scheduledEvent);

        expect(warn).not.toHaveBeenCalled();
        const payload = info.mock.calls[0][1];
        expect(payload).toMatchObject({
            event: SCHEDULED_JOB_EVENT,
            job: 'dailyFirestoreBackup',
            outcome: 'succeeded',
            operation: 'operations/op-123',
        });
        expect(payload.outputUriPrefix).toMatch(
            /^gs:\/\/respaldos-prueba\/firestore-backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
        );
    });

    it('sin bucket falla con el nombre de la función en el log (alerta de fallo)', async () => {
        delete process.env.FIRESTORE_BACKUP_BUCKET;
        const { dailyFirestoreBackup } = await import('../src/schedules/backup.schedule');

        await expect(dailyFirestoreBackup.run(scheduledEvent)).rejects.toThrow(
            'FIRESTORE_BACKUP_BUCKET',
        );

        expect(info).not.toHaveBeenCalled();
        expect(warn.mock.calls[0][1]).toMatchObject({
            job: 'dailyFirestoreBackup',
            outcome: 'failed',
        });
    });
});

describe('toda función programada queda vigilada', () => {
    const schedulesDir = path.join(__dirname, '../src/schedules');
    const sources = fs
        .readdirSync(schedulesDir)
        .filter((file) => file.endsWith('.schedule.ts'))
        .map((file) => fs.readFileSync(path.join(schedulesDir, file), 'utf8'));
    const declared = sources.flatMap((source) =>
        [...source.matchAll(/export const (\w+) = onSchedule\(/g)].map((match) => match[1]),
    );
    const jobsTable = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../scripts/ops/scheduled-jobs.json'), 'utf8'),
    ) as { jobs: { name: string; retryCount: number }[] };

    it('cada onSchedule envuelve su handler con monitoredJob y su propio nombre', () => {
        expect(declared.length).toBeGreaterThan(0);
        for (const name of declared) {
            const source = sources.find((s) => s.includes(`export const ${name} = onSchedule(`));
            expect(source).toContain(`monitoredJob('${name}'`);
        }
    });

    it('cada una tiene política de fallo en scripts/ops/scheduled-jobs.json', () => {
        expect(jobsTable.jobs.map((job) => job.name).sort()).toEqual([...declared].sort());
        for (const job of jobsTable.jobs) {
            const declaration = `export const ${job.name} = onSchedule(`;
            const source = sources.find((s) => s.includes(declaration))!;
            const block = source.slice(source.indexOf(declaration));
            const options = block.slice(0, block.indexOf('monitoredJob('));
            const retry = /retryCount:\s*(\d+)/.exec(options);
            // Sin `retryCount` Cloud Scheduler no reintenta: el primer fallo es definitivo.
            expect(job.retryCount).toBe(retry ? Number(retry[1]) : 0);
        }
    });
});
