import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import { sendAccountantMonthlyReport } from '../src/services/accountant-report-sender.service';
import { accountantReportTrigger } from '../src/schedules/accountant-report.schedule';

jest.mock('../src/services/accountant-report-sender.service', () => ({
    sendAccountantMonthlyReport: jest.fn(),
}));

const SECRETO = 'secreto-de-prueba';
const enviar = sendAccountantMonthlyReport as jest.Mock;

describe('accountantReportTrigger', () => {
    let server: Server;
    let base: string;
    const secretoPrevio = process.env.MIGRATE_SECRET;

    beforeAll(async () => {
        process.env.MIGRATE_SECRET = SECRETO;
        const app = express();
        // Los tipos de express de firebase-functions son otra copia; el objeto es el mismo.
        app.all('/', (req, res) => accountantReportTrigger(req as never, res as never));
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        process.env.MIGRATE_SECRET = secretoPrevio;
        await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
        enviar.mockReset();
        enviar.mockResolvedValue({ month: '2026-10', recipients: 1, sent: 1, failed: [] });
    });

    const disparar = (query = '', headers: Record<string, string> = {}, method = 'POST') =>
        fetch(`${base}/${query}`, { method, headers });

    it('sin el secreto contesta 403 y no genera nada', async () => {
        const sinHeader = await disparar('?month=2026-10');
        const conOtro = await disparar('?month=2026-10', { 'x-migrate-secret': 'otro' });
        expect(sinHeader.status).toBe(403);
        expect(conOtro.status).toBe(403);
        expect(await conOtro.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(enviar).not.toHaveBeenCalled();
    });

    it('solo acepta POST', async () => {
        const respuesta = await disparar('', { 'x-migrate-secret': SECRETO }, 'GET');
        expect(respuesta.status).toBe(405);
        expect(enviar).not.toHaveBeenCalled();
    });

    it('rechaza un mes mal formado', async () => {
        const respuesta = await disparar('?month=2026-13', { 'x-migrate-secret': SECRETO });
        expect(respuesta.status).toBe(400);
        expect(enviar).not.toHaveBeenCalled();
    });

    it('con month manda ese mes y devuelve el resultado en el envelope', async () => {
        const respuesta = await disparar('?month=2026-10', { 'x-migrate-secret': SECRETO });
        expect(respuesta.status).toBe(200);
        expect(await respuesta.json()).toEqual({
            data: { month: '2026-10', recipients: 1, sent: 1, failed: [] },
        });
        expect(enviar).toHaveBeenCalledWith(2026, 10);
    });

    it('sin month deja al sender elegir el mes anterior', async () => {
        await disparar('', { 'x-migrate-secret': SECRETO });
        expect(enviar).toHaveBeenCalledWith();
    });

    it('si el envío falla contesta 500 con el error del sistema, sin detalles', async () => {
        enviar.mockRejectedValue(new Error('Resend caído'));
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const respuesta = await disparar('?month=2026-10', { 'x-migrate-secret': SECRETO });
        expect(respuesta.status).toBe(500);
        expect(await respuesta.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
        errorLog.mockRestore();
    });
});
