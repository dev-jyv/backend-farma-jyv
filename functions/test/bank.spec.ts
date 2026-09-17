/**
 * Bancos y conciliación.
 *
 * Dos reglas cargan con el peso:
 *
 * 1. El saldo de una cuenta **se calcula** desde el saldo inicial más lo que ya
 *    vive en otras colecciones. Guardarlo obligaría a actualizarlo desde cuatro
 *    sitios, y el día que uno fallara nadie sabría cuál número es el bueno.
 * 2. Un traspaso caja↔banco escribe **las dos mitades o ninguna**. A medias, el
 *    dinero aparece duplicado o desaparecido, que es el descuadre que este
 *    módulo vino a cerrar.
 */

jest.mock('../src/utils/storage', () => ({
    getFileMetadata: jest.fn(async () => ({
        fileName: 'factura.pdf',
        mimeType: 'application/pdf',
    })),
    getFileUrl: jest.fn(async () => 'https://signed.example/factura.pdf'),
}));

import * as accountingService from '../src/services/accounting.service';
import * as bankService from '../src/services/bank.service';
import * as cashMovementsRepo from '../src/repositories/cash-movements.repository';
import * as invoicesService from '../src/services/invoices.service';
import * as suppliersRepo from '../src/repositories/suppliers.repository';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const isoDay = (offsetDays = 0): string =>
    new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const createAccount = (openingBalance = 10000) =>
    bankService.createAccount(
        {
            name: unique('Cuenta'),
            bank: 'Santander',
            last4: '4321',
            openingBalance,
            openingDate: isoDay(-90),
        },
        'admin-user',
        'admin',
    );

const balanceOf = async (accountId: string): Promise<number> => {
    const accounts = await bankService.getAccountsWithBalance({ includeInactive: true });
    return accounts.find((account) => account.id === accountId)!.balance;
};

describe('cuentas bancarias', () => {
    it('arrancan con su saldo inicial', async () => {
        const account = await createAccount(15000);

        expect(await balanceOf(account.id)).toBeCloseTo(15000, 2);
    });

    it('admiten arrancar sobregiradas en vez de recortar el saldo a cero', async () => {
        // Recortarlo no haría aparecer el dinero: solo movería el descuadre al
        // balance, donde ya nadie sabe de dónde salió.
        const account = await createAccount(-2500);

        expect(await balanceOf(account.id)).toBeCloseTo(-2500, 2);
    });

    it('una cuenta desactivada no admite movimientos', async () => {
        const account = await createAccount();
        await bankService.updateAccount(account.id, { isActive: false }, 'admin-user', 'admin');

        await expect(
            bankService.createMovement(
                {
                    accountId: account.id,
                    direction: 'in',
                    amount: 100,
                    occurredAt: isoDay(),
                    concept: 'Depósito',
                },
                'admin-user',
                'admin',
            ),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('movimientos y traspasos', () => {
    it('la entrada sube el saldo y la salida lo baja', async () => {
        const account = await createAccount(1000);

        await bankService.createMovement(
            {
                accountId: account.id,
                direction: 'in',
                amount: 500,
                occurredAt: isoDay(-1),
                concept: 'Depósito de terminal',
            },
            'admin-user',
            'admin',
        );
        await bankService.createMovement(
            {
                accountId: account.id,
                direction: 'out',
                amount: 200,
                occurredAt: isoDay(-1),
                concept: 'Comisión bancaria',
            },
            'admin-user',
            'admin',
        );

        expect(await balanceOf(account.id)).toBeCloseTo(1300, 2);
    });

    it('el traspaso a banco sube la cuenta y saca el efectivo del cajón', async () => {
        const account = await createAccount(0);

        const movement = await bankService.createTransfer(
            {
                accountId: account.id,
                direction: 'toBank',
                amount: 3000,
                occurredAt: isoDay(-1),
                concept: 'Depósito del corte',
            },
            'admin-user',
            'admin',
        );

        expect(await balanceOf(account.id)).toBeCloseTo(3000, 2);

        // La otra mitad existe y es efectivo que sale, sin turno: el traspaso no
        // puede descuadrarle la caja a ningún cajero.
        const cashMovement = await cashMovementsRepo.getMovementById(movement.cashMovementId!);
        expect(cashMovement).not.toBeNull();
        expect(cashMovement!.type).toBe('withdrawal');
        expect(cashMovement!.amount).toBe(3000);
        expect(cashMovement!.cashSessionId).toBeNull();
        expect(cashMovement!.paymentMethod).toBe('cash');
    });

    it('el traspaso a caja invierte las dos mitades', async () => {
        const account = await createAccount(5000);

        const movement = await bankService.createTransfer(
            {
                accountId: account.id,
                direction: 'toCash',
                amount: 1000,
                occurredAt: isoDay(-1),
                concept: 'Retiro para fondo fijo',
            },
            'admin-user',
            'admin',
        );

        expect(await balanceOf(account.id)).toBeCloseTo(4000, 2);
        const cashMovement = await cashMovementsRepo.getMovementById(movement.cashMovementId!);
        expect(cashMovement!.type).toBe('deposit');
    });

    it('conciliar y desconciliar deja el rastro sin borrar el movimiento', async () => {
        const account = await createAccount();
        const movement = await bankService.createMovement(
            {
                accountId: account.id,
                direction: 'in',
                amount: 100,
                occurredAt: isoDay(),
                concept: 'Depósito',
            },
            'admin-user',
            'admin',
        );

        const conciliado = await bankService.setReconciled(
            movement.id,
            true,
            'admin-user',
            'admin',
        );
        expect(conciliado.reconciledAt).not.toBeNull();

        await expect(
            bankService.setReconciled(movement.id, true, 'admin-user', 'admin'),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

        const deshecho = await bankService.setReconciled(
            movement.id,
            false,
            'admin-user',
            'admin',
        );
        expect(deshecho.reconciledAt).toBeNull();
    });
});

describe('el saldo baja con lo que sale de otras colecciones', () => {
    it('un gasto por transferencia descuenta de su cuenta', async () => {
        const account = await createAccount(10000);

        await accountingService.createExpense('admin-user', 'admin', 'Admin', {
            amount: 2500,
            reason: 'Renta',
            category: 'rent',
            paymentMethod: 'transfer',
            bankAccountId: account.id,
        });

        expect(await balanceOf(account.id)).toBeCloseTo(7500, 2);
    });

    it('un gasto en efectivo no toca ninguna cuenta aunque se mande la cuenta', async () => {
        const account = await createAccount(10000);

        await accountingService.createExpense('admin-user', 'admin', 'Admin', {
            amount: 400,
            reason: 'Garrafón',
            category: 'supplies',
            description: 'Agua',
            paymentMethod: 'cash',
            bankAccountId: account.id,
        });

        // Salió del cajón: bajar además el banco sería contar el gasto dos veces.
        expect(await balanceOf(account.id)).toBeCloseTo(10000, 2);
    });

    it('el abono a proveedor descuenta, y su cancelación devuelve el dinero', async () => {
        const account = await createAccount(10000);
        const supplier = await suppliersRepo.createSupplier({
            name: unique('Proveedor'),
            isActive: true,
        });
        const invoice = await invoicesService.createInvoice({
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: isoDay(-10),
            totalAmount: 4000,
            hasInvoice: false,
            userId: 'admin-user',
        });

        const { payment } = await invoicesService.registerPayment(invoice.id, {
            amount: 4000,
            paymentMethod: 'transfer',
            bankAccountId: account.id,
            userId: 'admin-user',
            roleSlug: 'admin',
        });
        expect(await balanceOf(account.id)).toBeCloseTo(6000, 2);

        await invoicesService.voidPayment(payment.id, {
            reason: 'Monto equivocado',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        // La contrapartida viene en negativo y devuelve el saldo sola.
        expect(await balanceOf(account.id)).toBeCloseTo(10000, 2);
    });
});

describe('conciliación', () => {
    it('publica la diferencia entre lo esperado y lo capturado', async () => {
        const account = await createAccount(0);
        const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const report = await bankService.getReconciliation({
            from,
            to,
            accountId: account.id,
        });

        expect(report.inflowGap).toBeCloseTo(
            report.expectedInflow - report.registeredInflow,
            2,
        );
        expect(report.accounts.some((row) => row.id === account.id)).toBe(true);
    });

    it('cuenta los movimientos sin marcar contra el estado de cuenta', async () => {
        const account = await createAccount();
        await bankService.createMovement(
            {
                accountId: account.id,
                direction: 'in',
                amount: 750,
                occurredAt: isoDay(),
                concept: unique('Depósito'),
            },
            'admin-user',
            'admin',
        );

        // Ventana de días: un movimiento fechado "hoy" se guarda a las 00:00, y
        // una ventana de horas alrededor de ahora lo dejaría fuera.
        const report = await bankService.getReconciliation({
            from: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            accountId: account.id,
        });

        expect(report.unreconciled.count).toBe(1);
        expect(report.unreconciled.total).toBeCloseTo(750, 2);
        expect(report.notes.join(' ')).toContain('sin marcar');
    });
});

describe('balance general con bancos', () => {
    it('deja de estimar el renglón de bancos cuando hay cuentas', async () => {
        await createAccount(1000);

        const balance = await accountingService.getBalanceSheet();

        expect(balance.assets.bankIsEstimated).toBe(false);
        expect(balance.notes.join(' ')).not.toContain('Bancos es un estimado');
    });
});
