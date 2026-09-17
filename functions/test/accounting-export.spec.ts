/**
 * Exportación de contabilidad.
 *
 * El archivo lo abre un contador en su despacho, sin la pantalla enfrente. De
 * ahí las dos reglas que se fijan aquí: los importes viajan como **número
 * crudo** —en cuanto llevan "$" o comas, Excel los trata como texto y la columna
 * deja de sumarse— y las advertencias de confiabilidad viajan **dentro** del
 * archivo, no en la interfaz que él no va a ver.
 */

import {
    expensesCsv,
    fixedAssetsCsv,
    incomeStatementCsv,
    payablesCsv,
} from '../src/services/accounting-export.service';
import { fromDate } from '../src/utils/firestore';
import { CashMovement } from '../src/types';
import { FixedAssetView } from '../src/services/accounting-core.service';
import { IncomeStatement, PayablesReport } from '../src/services/accounting.service';

const statement = (): IncomeStatement => ({
    period: { from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' },
    revenue: { pharmacy: 100000, services: 20000, gross: 120000, returns: 5000, net: 115000 },
    costOfSales: { merchandise: 60000, waste: 1000, total: 61000 },
    grossProfit: 54000,
    grossMarginRate: 46.96,
    operatingExpenses: {
        commissions: 3000,
        depreciation: 1000,
        byCategory: [
            {
                category: 'rent',
                label: 'Renta',
                total: 8000,
                count: 1,
                fromCashBox: 0,
                outsideCashBox: 8000,
                accrued: 0,
            },
        ],
        expensesTotal: 8000,
        total: 12000,
    },
    operatingIncome: 42000,
    operatingMarginRate: 36.52,
    taxes: { ivaCharged: 16000, iepsCharged: 0, ivaCreditable: 9600, ivaPayable: 6400 },
    reliability: {
        salesWithCost: 120,
        salesWithoutCost: 3,
        salesWithoutTaxBreakdown: 0,
        returnsWithoutCost: 0,
        wasteWithoutCost: 0,
        expensesOutsideCashBox: 1,
        accruedExpenses: 0,
        invoicesWithoutTaxBreakdown: 2,
        warnings: ['3 venta(s) del periodo no tienen costo capturado.'],
    },
});

describe('CSV del estado de resultados', () => {
    it('lleva importes sin formato para que la hoja de cálculo los sume', () => {
        const csv = incomeStatementCsv(statement());

        expect(csv).toContain('Ingreso neto,115000.00');
        expect(csv).not.toContain('$');
        // Un separador de miles convertiría la columna en texto.
        expect(csv).not.toMatch(/\d,\d{3}\.\d{2}/);
    });

    it('resta con signo negativo en vez de esconderlo entre paréntesis', () => {
        const csv = incomeStatementCsv(statement());

        // "(8,000.00)" no es un número para Excel; -8000.00 sí.
        expect(csv).toContain('Renta,-8000.00');
        expect(csv).toContain('Devoluciones,-5000.00');
    });

    it('arrastra las advertencias dentro del archivo', () => {
        const csv = incomeStatementCsv(statement());

        expect(csv).toContain('Notas');
        expect(csv).toContain('no tienen costo capturado');
    });

    it('abre con BOM, o Excel parte los acentos', () => {
        expect(incomeStatementCsv(statement()).startsWith('﻿')).toBe(true);
    });
});

describe('CSV del auxiliar de gastos', () => {
    const movement = (overrides: Partial<CashMovement> = {}): CashMovement =>
        ({
            id: 'mv-1',
            cashSessionId: null,
            type: 'expense',
            amount: 1500,
            reason: 'Nómina quincena',
            category: 'salary',
            description: null,
            paymentMethod: 'transfer',
            createdBy: 'u-1',
            createdByLabel: 'Admin',
            createdAt: fromDate(new Date('2026-03-20T12:00:00Z')),
            occurredAt: fromDate(new Date('2026-03-15T00:00:00Z')),
            ...overrides,
        }) as CashMovement;

    it('fecha por ocurrencia, no por captura', () => {
        const csv = expensesCsv([movement()]);

        // La renta de marzo capturada en abril pertenece a marzo; exportarla con
        // la fecha de captura la movería de mes en la contabilidad del despacho.
        expect(csv).toContain('2026-03-15');
        expect(csv).not.toContain('2026-03-20');
    });

    it('distingue el origen del gasto', () => {
        const csv = expensesCsv([movement(), movement({ cashSessionId: 'cs-1' })]);

        expect(csv).toContain('Fuera de caja');
        expect(csv).toContain('Del cajón');
    });

    it('entrecomilla el texto con comas en vez de partir la columna', () => {
        const csv = expensesCsv([movement({ reason: 'Pago a Juan, quincena 1' })]);

        expect(csv).toContain('"Pago a Juan, quincena 1"');
    });

    it('un gasto anterior a contabilidad se lee como efectivo', () => {
        const csv = expensesCsv([movement({ paymentMethod: undefined })]);

        expect(csv).toContain('cash');
    });
});

describe('CSV de cuentas por pagar y activo fijo', () => {
    it('cierra el auxiliar de proveedores con su total', () => {
        const report: PayablesReport = {
            asOf: '2026-03-31T00:00:00.000Z',
            total: 1500,
            overdueTotal: 1000,
            invoiceCount: 1,
            buckets: [],
            bySupplier: [],
            invoices: [
                {
                    id: 'inv-1',
                    invoiceNumber: 'A-100',
                    supplierId: 's-1',
                    supplierName: 'Distribuidora',
                    invoiceDate: '2026-02-01T00:00:00.000Z',
                    dueDate: '2026-03-01T00:00:00.000Z',
                    totalAmount: 2000,
                    paidTotal: 500,
                    balance: 1500,
                    isOverdue: true,
                    daysOverdue: 30,
                    bucket: 'd1_30',
                },
            ],
        };

        const csv = payablesCsv(report);

        expect(csv).toContain(
            'A-100,Distribuidora,2026-02-01,2026-03-01,30,2000.00,500.00,1500.00',
        );
        expect(csv.trimEnd().endsWith('1500.00')).toBe(true);
    });

    it('el bien sin baja deja la columna vacía en vez de una fecha inventada', () => {
        const asset = {
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
            accumulatedDepreciation: 6000,
            netValue: 6000,
            monthlyDepreciation: 1000,
            fullyDepreciated: false,
        } as unknown as FixedAssetView;

        const csv = fixedAssetsCsv([asset]);

        expect(csv).toContain('Refrigerador,equipment,2026-01-01,12000.00');
        expect(csv.trimEnd().endsWith(',')).toBe(true);
    });
});
