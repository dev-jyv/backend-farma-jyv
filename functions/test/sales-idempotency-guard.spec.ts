import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { SalesController } from '../src/modules/sales/sales.controller';
import { AuthUser } from '../src/types';

/**
 * Sin llave de idempotencia, un reintento por corte de red vuelve a cobrar y a
 * descontar stock. El hueco se cierra en dos tiempos: primero avisar —el POS de
 * escritorio es otro despliegue y exigirla de golpe dejaría a la farmacia sin
 * cobrar—, y después exigirla con `SALES_REQUIRE_IDEMPOTENCY_KEY`.
 *
 * Aquí se fija ese interruptor. El alta en sí vive en `sales.spec.ts`.
 */

jest.mock('../src/services/sales.service', () => ({
    createSale: jest.fn(async (input: Record<string, unknown>) => ({ id: 's-1', ...input })),
}));

import * as salesService from '../src/services/sales.service';

const usuario = (): AuthUser =>
    ({ uid: 'cajera-1', role: { slug: 'cashier' } }) as unknown as AuthUser;

const cuerpo = () =>
    ({
        items: [{ productId: 'p-1', quantity: 1 }],
        paymentMethod: 'cash',
    }) as unknown as Parameters<SalesController['create']>[0];

describe('llave de idempotencia en el alta de venta', () => {
    const controller = new SalesController();
    let avisos: jest.SpyInstance;

    beforeEach(() => {
        delete process.env.SALES_REQUIRE_IDEMPOTENCY_KEY;
        avisos = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        (salesService.createSale as jest.Mock).mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.SALES_REQUIRE_IDEMPOTENCY_KEY;
    });

    it('con la bandera apagada deja pasar la venta sin llave, pero avisa', async () => {
        await controller.create(cuerpo(), usuario(), undefined);

        expect(salesService.createSale).toHaveBeenCalledTimes(1);
        // El aviso nombra al cajero: es lo que permite saber qué cliente falta
        // actualizar antes de encender la bandera.
        expect(avisos).toHaveBeenCalledWith(expect.stringContaining('cajera-1'));
    });

    it('con la bandera encendida rechaza la venta sin llave', async () => {
        process.env.SALES_REQUIRE_IDEMPOTENCY_KEY = 'true';

        await expect(controller.create(cuerpo(), usuario(), undefined)).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('idempotencia'),
        });
        expect(salesService.createSale).not.toHaveBeenCalled();
    });

    it('la llave del header vale igual que la del cuerpo', async () => {
        process.env.SALES_REQUIRE_IDEMPOTENCY_KEY = 'true';

        await controller.create(cuerpo(), usuario(), 'a1b2c3d4-e5f6');

        expect(salesService.createSale).toHaveBeenCalledWith(
            expect.objectContaining({ idempotencyKey: 'a1b2c3d4-e5f6' }),
        );
        expect(avisos).not.toHaveBeenCalled();
    });

    it('con llave en el cuerpo no avisa ni rechaza', async () => {
        const body = { ...cuerpo(), idempotencyKey: 'llave-del-cobro-1' } as ReturnType<
            typeof cuerpo
        >;

        await controller.create(body, usuario(), undefined);

        expect(salesService.createSale).toHaveBeenCalledWith(
            expect.objectContaining({ idempotencyKey: 'llave-del-cobro-1' }),
        );
        expect(avisos).not.toHaveBeenCalled();
    });
});
