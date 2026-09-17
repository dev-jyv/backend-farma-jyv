/**
 * Activo fijo, capital, saldos de apertura, cierre de periodo y balance general.
 *
 * Tres reglas cargan con el peso y por eso se fijan aquí:
 *
 * 1. La depreciación se **calcula**, no se guarda: un proceso mensual que no
 *    corre un mes deja el estado de resultados mudo sin que nadie se entere.
 * 2. El cierre de periodo rechaza movimientos fechados hacia atrás. Sin él, un
 *    estado de resultados ya firmado cambia de cifra cuando alguien captura un
 *    gasto "del mes pasado".
 * 3. El balance publica su descuadre. Cuadrarlo con una cifra de ajuste
 *    silenciosa es peor que no tenerlo: nadie vuelve a buscar la diferencia.
 */

jest.mock('../src/utils/storage', () => ({
    getFileMetadata: jest.fn(async () => ({
        fileName: 'factura.pdf',
        mimeType: 'application/pdf',
    })),
    getFileUrl: jest.fn(async () => 'https://signed.example/factura.pdf'),
}));

import * as accountingCore from '../src/services/accounting-core.service';
import * as accountingRepo from '../src/repositories/accounting.repository';
import * as accountingService from '../src/services/accounting.service';
import * as invoicesService from '../src/services/invoices.service';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import { fromDate } from '../src/utils/firestore';
import { FixedAsset } from '../src/types';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const isoDay = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Bien en memoria, para probar el cálculo sin tocar Firestore. */
const asset = (overrides: Partial<FixedAsset> = {}): FixedAsset =>
    ({
        id: 'fa-1',
        name: 'Refrigerador',
        category: 'equipment',
        acquiredAt: fromDate(new Date('2026-01-01T00:00:00Z')),
        cost: 12000,
        usefulLifeMonths: 12,
        salvageValue: 0,
        disposedAt: null,
        createdBy: 'u-1',
        createdAt: fromDate(new Date('2026-01-01T00:00:00Z')),
        ...overrides,
    }) as FixedAsset;

/** Deja la configuración como la encontró: el emulador es compartido. */
const resetSettings = async () => {
    await accountingRepo.saveSettings(
        { startDate: null, closedThrough: null },
        'test-cleanup',
    );
};

describe('depreciación en línea recta', () => {
    it('reparte la base a lo largo de la vida útil', () => {
        const cents = accountingCore.accumulatedDepreciationCents(
            asset(),
            new Date('2027-01-01T00:00:00Z'),
        );

        // 12 000 en 12 meses: al año está depreciado por completo.
        expect(cents).toBe(1200000);
    });

    it('descuenta el valor de rescate de la base', () => {
        const cents = accountingCore.accumulatedDepreciationCents(
            asset({ cost: 12000, salvageValue: 2000 }),
            new Date('2027-01-01T00:00:00Z'),
        );

        expect(cents).toBe(1000000);
    });

    it('no deprecia más allá de la vida útil', () => {
        const cents = accountingCore.accumulatedDepreciationCents(
            asset(),
            new Date('2030-01-01T00:00:00Z'),
        );

        expect(cents).toBe(1200000);
    });

    it('prorratea por días dentro del rango pedido', () => {
        // Un mes de los doce: alrededor de una doceava parte, no el año entero.
        const cents = accountingCore.depreciationInRangeCents(
            asset(),
            new Date('2026-03-01T00:00:00Z'),
            new Date('2026-04-01T00:00:00Z'),
        );

        expect(cents).toBeGreaterThan(90000);
        expect(cents).toBeLessThan(110000);
    });

    it('deja de depreciar desde la baja del bien', () => {
        const dado = asset({ disposedAt: fromDate(new Date('2026-07-01T00:00:00Z')) });

        const alCierre = accountingCore.accumulatedDepreciationCents(
            dado,
            new Date('2027-01-01T00:00:00Z'),
        );
        const alaBaja = accountingCore.accumulatedDepreciationCents(
            dado,
            new Date('2026-07-01T00:00:00Z'),
        );

        // Después de la baja el acumulado ya no se mueve.
        expect(alCierre).toBe(alaBaja);
        expect(alCierre).toBeLessThan(1200000);
    });

    it('un bien sin vida útil no deprecia en vez de dividir entre cero', () => {
        const cents = accountingCore.accumulatedDepreciationCents(
            asset({ usefulLifeMonths: 0 }),
            new Date('2027-01-01T00:00:00Z'),
        );

        expect(cents).toBe(0);
    });
});

describe('activo fijo', () => {
    afterAll(resetSettings);

    it('se da de alta y se lee con su valor neto', async () => {
        const created = await accountingCore.createFixedAsset(
            {
                name: unique('Vitrina'),
                category: 'furniture',
                acquiredAt: isoDay(-365),
                cost: 24000,
                usefulLifeMonths: 24,
                salvageValue: 0,
            },
            'admin-user',
            'admin',
        );

        expect(created.monthlyDepreciation).toBeCloseTo(1000, 2);
        // Un año de los dos: alrededor de la mitad depreciada.
        expect(created.accumulatedDepreciation).toBeGreaterThan(11000);
        expect(created.netValue).toBeLessThan(13000);
        expect(created.fullyDepreciated).toBe(false);
    });

    it('rechaza un rescate que deja la base en cero o negativa', async () => {
        const created = await accountingCore.createFixedAsset(
            {
                name: unique('Equipo'),
                category: 'equipment',
                acquiredAt: isoDay(-30),
                cost: 10000,
                usefulLifeMonths: 12,
                salvageValue: 0,
            },
            'admin-user',
            'admin',
        );

        await expect(
            accountingCore.updateFixedAsset(
                created.id,
                { salvageValue: 10000 },
                'admin-user',
                'admin',
            ),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('un bien dado de baja sale del listado y ya no se corrige', async () => {
        const created = await accountingCore.createFixedAsset(
            {
                name: unique('Impresora'),
                category: 'computing',
                acquiredAt: isoDay(-60),
                cost: 5000,
                usefulLifeMonths: 36,
                salvageValue: 0,
            },
            'admin-user',
            'admin',
        );

        await accountingCore.disposeFixedAsset(
            created.id,
            { disposedAt: isoDay(-1), disposalAmount: 1200, reason: 'Vendida' },
            'admin-user',
            'admin',
        );

        const { items } = await accountingCore.listFixedAssets();
        expect(items.some((item) => item.id === created.id)).toBe(false);

        const conBajas = await accountingCore.listFixedAssets({ includeDisposed: true });
        expect(conBajas.items.some((item) => item.id === created.id)).toBe(true);

        await expect(
            accountingCore.updateFixedAsset(created.id, { cost: 1 }, 'admin-user', 'admin'),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('capital', () => {
    afterAll(resetSettings);

    it('suma aportaciones y resta retiros', async () => {
        const partner = unique('Socio');
        await accountingCore.createEquityMovement(
            { type: 'contribution', amount: 50000, occurredAt: isoDay(-10), partner },
            'admin-user',
            'admin',
        );
        await accountingCore.createEquityMovement(
            { type: 'withdrawal', amount: 20000, occurredAt: isoDay(-5), partner },
            'admin-user',
            'admin',
        );

        const report = await accountingCore.listEquityMovements({
            from: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
        });
        const mine = report.movements.filter((movement) => movement.partner === partner);

        expect(mine).toHaveLength(2);
        expect(report.contributions).toBeGreaterThanOrEqual(50000);
        expect(report.withdrawals).toBeGreaterThanOrEqual(20000);
        expect(report.net).toBeCloseTo(report.contributions - report.withdrawals, 2);
    });
});

/**
 * El cierre vive en un documento **global**, así que cerrarlo de verdad aquí
 * bloquearía los gastos que otras suites capturan en paralelo. El guard se prueba
 * con la configuración espiada: lo que importa es que `assertPeriodOpen` lea
 * `closedThrough` y rechace, no que el documento se haya escrito.
 */
describe('cierre de periodo', () => {
    const conCierreHasta = (offsetDays: number) => {
        jest.spyOn(accountingRepo, 'getSettings').mockResolvedValue({
            startDate: null,
            openingBalances: {
                cash: 0,
                bank: 0,
                inventory: 0,
                payables: 0,
                fixedAssets: 0,
                accumulatedDepreciation: 0,
                equityContributions: 0,
                retainedEarnings: 0,
            },
            closedThrough: fromDate(
                new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000),
            ),
        });
    };

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('rechaza un gasto fechado dentro de lo cerrado', async () => {
        conCierreHasta(-10);

        await expect(
            accountingService.createExpense('admin-user', 'admin', 'Admin', {
                amount: 500,
                reason: 'Renta atrasada',
                category: 'rent',
                paymentMethod: 'transfer',
                occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
            }),
        ).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringContaining('periodo está cerrado'),
        });
    });

    it('deja pasar el gasto posterior al cierre', async () => {
        conCierreHasta(-10);

        const movement = await accountingService.createExpense('admin-user', 'admin', 'Admin', {
            amount: 500,
            reason: 'Renta del mes',
            category: 'rent',
            paymentMethod: 'transfer',
            occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        });

        expect(movement.id).toBeTruthy();
    });

    it('rechaza un abono a proveedor dentro de lo cerrado', async () => {
        const supplier = await suppliersRepo.createSupplier({
            name: unique('Proveedor'),
            isActive: true,
        });
        const invoice = await invoicesService.createInvoice({
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: isoDay(-30),
            totalAmount: 1000,
            hasInvoice: false,
            userId: 'admin-user',
        });

        conCierreHasta(-10);

        await expect(
            invoicesService.registerPayment(invoice.id, {
                amount: 100,
                paymentMethod: 'transfer',
                paidAt: isoDay(-20),
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('reabrir borra el cierre y vuelve a dejar pasar', async () => {
        // Se escribe de verdad, pero hacia `null`: reabierto es el estado por
        // defecto, así que ninguna otra suite se ve afectada.
        const settings = await accountingCore.closePeriod(null, 'admin-user', 'admin');
        expect(settings.closedThrough).toBeNull();

        const movement = await accountingService.createExpense('admin-user', 'admin', 'Admin', {
            amount: 300,
            reason: 'Luz atrasada',
            category: 'electricity',
            paymentMethod: 'transfer',
            occurredAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        });

        expect(movement.id).toBeTruthy();
    });

    it('no se puede cerrar un periodo que todavía no termina', async () => {
        await expect(
            accountingCore.closePeriod(isoDay(5), 'admin-user', 'admin'),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('corrección de facturas y cancelación de abonos', () => {
    const createInvoice = async () => {
        const supplier = await suppliersRepo.createSupplier({
            name: unique('Proveedor'),
            isActive: true,
        });
        return invoicesService.createInvoice({
            supplierId: supplier.id,
            invoiceNumber: unique('FAC'),
            invoiceDate: isoDay(-5),
            totalAmount: 1160,
            hasInvoice: false,
            userId: 'admin-user',
        });
    };

    it('agrega el desglose y el vencimiento después del alta', async () => {
        const invoice = await createInvoice();

        const updated = await invoicesService.updateAccounting(invoice.id, {
            dueDate: isoDay(25),
            taxes: { subtotal: 1000, ivaAmount: 160, iepsAmount: 0 },
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(updated.taxes).toEqual({ subtotal: 1000, ivaAmount: 160, iepsAmount: 0 });
        expect(updated.dueDate).not.toBeNull();
    });

    it('sigue exigiendo que el desglose sume el total', async () => {
        const invoice = await createInvoice();

        await expect(
            invoicesService.updateAccounting(invoice.id, {
                taxes: { subtotal: 1000, ivaAmount: 10, iepsAmount: 0 },
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('cancelar un abono deja contrapartida y devuelve el saldo', async () => {
        const invoice = await createInvoice();
        const { payment } = await invoicesService.registerPayment(invoice.id, {
            amount: 600,
            paymentMethod: 'transfer',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        const { invoice: afterVoid } = await invoicesService.voidPayment(payment.id, {
            reason: 'Monto equivocado',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        expect(afterVoid.paidTotal).toBe(0);
        expect(afterVoid.balance).toBe(1160);
        expect(afterVoid.paymentStatus).toBe('pending');

        // El original se conserva marcado, y su reverso queda enfrente: borrarlo
        // dejaría un saldo que subió sin que nada lo explique.
        const payments = await invoicesService.listPayments(invoice.id);
        expect(payments).toHaveLength(2);
        expect(payments.find((item) => item.id === payment.id)!.voidedAt).toBeTruthy();
        expect(payments.find((item) => item.amount === -600)!.voidsPaymentId).toBe(payment.id);
    });

    it('un abono cancelado no se cancela dos veces', async () => {
        const invoice = await createInvoice();
        const { payment } = await invoicesService.registerPayment(invoice.id, {
            amount: 100,
            paymentMethod: 'cash',
            userId: 'admin-user',
            roleSlug: 'admin',
        });
        await invoicesService.voidPayment(payment.id, {
            reason: 'Duplicado',
            userId: 'admin-user',
            roleSlug: 'admin',
        });

        await expect(
            invoicesService.voidPayment(payment.id, {
                reason: 'Otra vez',
                userId: 'admin-user',
                roleSlug: 'admin',
            }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('balance general', () => {
    afterAll(resetSettings);

    it('cuadra su propia aritmética y publica el descuadre', async () => {
        await accountingCore.updateSettings(
            { startDate: isoDay(-1), openingBalances: { cash: 5000, bank: 20000 } },
            'admin-user',
            'admin',
        );

        const balance = await accountingService.getBalanceSheet();

        expect(balance.startDate).not.toBeNull();
        // Los totales son la suma de sus renglones; sin esto, un rubro podría
        // quedarse fuera del total y el descuadre lo escondería.
        expect(balance.assets.total).toBeCloseTo(
            balance.assets.cash +
                balance.assets.bank +
                balance.assets.inventory +
                balance.assets.fixedAssetsNet,
            2,
        );
        expect(balance.liabilities.total).toBeCloseTo(
            balance.liabilities.payables + balance.liabilities.taxesPayable,
            2,
        );
        expect(balance.equity.total).toBeCloseTo(
            balance.equity.contributions -
                balance.equity.withdrawals +
                balance.equity.openingRetainedEarnings +
                balance.equity.periodResult,
            2,
        );
        // El cuadre se publica siempre, cuadre o no: es la cifra que dice si el
        // balance se puede firmar.
        expect(balance.check.difference).toBeCloseTo(
            balance.assets.total - balance.liabilities.total - balance.equity.total,
            2,
        );
        expect(balance.check.balanced).toBe(Math.abs(balance.check.difference) <= 1);
        // La nota del efectivo va siempre; la de bancos solo mientras no haya
        // cuentas dadas de alta, y otras suites las crean en paralelo.
        expect(balance.notes.join(' ')).toContain('El efectivo se calcula');
    });

    it('los saldos de apertura entran al activo', async () => {
        await accountingCore.updateSettings(
            { startDate: isoDay(-1), openingBalances: { cash: 1000, bank: 1000 } },
            'admin-user',
            'admin',
        );
        const antes = await accountingService.getBalanceSheet();

        await accountingCore.updateSettings(
            { openingBalances: { cash: 1_000_000 } },
            'admin-user',
            'admin',
        );
        const despues = await accountingService.getBalanceSheet();

        // Holgura amplia: el emulador es compartido y otras suites mueven
        // efectivo entre las dos lecturas. Lo que se comprueba es que la
        // apertura viaja al activo, no la cifra al centavo.
        expect(despues.assets.cash - antes.assets.cash).toBeGreaterThan(900_000);
    });

    it('sin fecha de arranque lo dice en las notas', async () => {
        await accountingCore.updateSettings({ startDate: null }, 'admin-user', 'admin');

        const balance = await accountingService.getBalanceSheet();

        expect(balance.startDate).toBeNull();
        expect(balance.notes.join(' ')).toContain('fecha de arranque');
    });
});
