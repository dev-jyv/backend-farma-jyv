/**
 * Herramientas del asistente sobre gastos, contabilidad, facturas, cortes de caja,
 * clientes e inventario. Se fija lo que el modelo recibe (agregados, sin datos
 * personales de clientes, parámetros saneados), no la calidad de sus respuestas.
 */

const openRouterRequest = jest.fn();
jest.mock('../src/services/openrouter.service', () => ({ openRouterRequest }));

jest.mock('../src/services/analytics.service', () => ({}));
jest.mock('../src/services/inventory-alerts.service', () => ({}));
jest.mock('../src/services/business-summary.service', () => ({}));
jest.mock('../src/services/service-analytics.service', () => ({}));
jest.mock('../src/services/inventory-summary.service', () => ({}));

const getRepeatCustomers = jest.fn();
jest.mock('../src/services/insights.service', () => ({ getRepeatCustomers }));

const listExpenses = jest.fn();
const getIncomeStatement = jest.fn();
jest.mock('../src/services/accounting.service', () => ({ listExpenses, getIncomeStatement }));

const listInvoicesUpTo = jest.fn();
jest.mock('../src/services/invoices.service', () => ({ listInvoicesUpTo }));

const listCashSessions = jest.fn();
jest.mock('../src/services/cash-sessions.service', () => ({ listCashSessions }));
jest.mock('../src/services/dashboard-charts.service', () => ({}));

const listProducts = jest.fn();
jest.mock('../src/repositories/products.repository', () => ({ listProducts }));
const listBatchesWithStock = jest.fn();
jest.mock('../src/repositories/batches.repository', () => ({ listBatchesWithStock }));

import { chat } from '../src/services/assistant.service';

const at = (iso: string) => {
    const date = new Date(iso);
    return { toMillis: () => date.getTime(), toDate: () => date };
};

/** Pide una herramienta y devuelve lo que el modelo recibió de ella. */
const toolResult = async (name: string, args: Record<string, unknown> = {}) => {
    openRouterRequest
        .mockResolvedValueOnce({
            model: 'm',
            choices: [
                {
                    message: {
                        content: null,
                        tool_calls: [
                            { id: 'c1', function: { name, arguments: JSON.stringify(args) } },
                        ],
                    },
                },
            ],
        })
        .mockResolvedValueOnce({ model: 'm', choices: [{ message: { content: 'ok' } }] });
    await chat([{ role: 'user', content: 'pregunta' }]);
    const messages = openRouterRequest.mock.calls.at(-1)![1].messages as Array<{
        role: string;
        content: string;
    }>;
    return JSON.parse(messages.filter((message) => message.role === 'tool').at(-1)!.content);
};

describe('asistente: herramientas de negocio', () => {
    beforeEach(() => jest.clearAllMocks());

    it('clientes recurrentes: solo agregados, sin nombres ni ids', async () => {
        getRepeatCustomers.mockResolvedValue({
            identifiedSales: 10,
            anonymousSales: 5,
            customers: 4,
            repeatCustomers: 2,
            repeatRate: 50,
            items: [
                {
                    customerId: 'c1',
                    customerName: 'Juan Pérez',
                    purchases: 4,
                    total: 900,
                    lastPurchaseAt: 'x',
                },
            ],
        });

        const result = await toolResult('repeat_customers');

        expect(result).toMatchObject({ customers: 4, repeatRate: 50 });
        expect(result.topSpendersAnonymous).toEqual([{ purchases: 4, total: 900 }]);
        expect(JSON.stringify(result)).not.toContain('Juan');
        expect(JSON.stringify(result)).not.toContain('c1');
    });

    it('gastos: total, por categoría y quién registró; sin fechas, mes en curso', async () => {
        listExpenses.mockResolvedValue({
            items: [
                {
                    amount: 100,
                    reason: 'Renta',
                    category: 'rent',
                    createdAt: at('2026-10-05T16:00:00Z'),
                    createdByLabel: 'Ana',
                },
                {
                    amount: 50,
                    reason: 'Luz',
                    category: 'electricity',
                    createdAt: at('2026-10-06T16:00:00Z'),
                },
                {
                    amount: 30,
                    reason: 'Otro',
                    category: 'rent',
                    createdAt: at('2026-10-07T16:00:00Z'),
                },
            ],
            meta: { total: 3 },
        });

        const result = await toolResult('expenses');

        expect(result).toMatchObject({ count: 3, totalAmount: 180, truncated: false });
        expect(result.byCategory[0]).toMatchObject({ total: 130, count: 2 });
        expect(result.latest[0]).toMatchObject({ registeredBy: 'Ana' });
        const filters = listExpenses.mock.calls[0][0];
        expect(new Date(filters.from).getTime()).toBeLessThan(new Date(filters.to).getTime());
    });

    it('facturas: ignora un estado inválido y acota el límite', async () => {
        listInvoicesUpTo.mockResolvedValue({
            items: [
                {
                    supplier: { name: 'Nadro' },
                    invoiceNumber: 'A-1',
                    invoiceDate: at('2026-10-01T12:00:00Z'),
                    dueDate: null,
                    totalAmount: 500,
                    paidTotal: 200,
                    balance: 300,
                    paymentStatus: 'partial',
                    isOverdue: true,
                },
            ],
            total: 1,
        });

        const result = await toolResult('supplier_invoices', { status: 'hackeado', limit: 9999 });

        expect(listInvoicesUpTo.mock.calls[0][0]).toMatchObject({ paymentStatus: undefined });
        expect(listInvoicesUpTo).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ outstandingBalance: 300, balanceIsPartial: false });
        expect(result.invoices[0]).toMatchObject({
            supplier: 'Nadro',
            number: 'A-1',
            overdue: true,
        });
    });

    it('facturas: el saldo suma todas las que coinciden aunque se listen pocas', async () => {
        const invoice = (balance: number) => ({
            supplier: { name: 'Nadro' },
            invoiceNumber: 'A',
            invoiceDate: at('2026-10-01T12:00:00Z'),
            dueDate: at('2026-10-31T23:30:00Z'),
            totalAmount: balance,
            paidTotal: 0,
            balance,
            paymentStatus: 'pending',
            isOverdue: false,
        });
        listInvoicesUpTo.mockResolvedValue({
            items: Array.from({ length: 130 }, () => invoice(10)),
            total: 130,
        });

        const result = await toolResult('supplier_invoices', { limit: 5 });

        expect(result).toMatchObject({
            total: 130,
            shown: 5,
            outstandingBalance: 1300,
            balanceIsPartial: false,
        });
        // 23:30 UTC del 31 es todavía el 31 en Ciudad de México (17:30).
        expect(result.invoices[0].dueDate).toBe('2026-10-31');
    });

    it('cortes de caja: devuelve esperado, contado y diferencia por turno', async () => {
        listCashSessions.mockResolvedValue({
            items: [
                {
                    openedByLabel: 'Luis',
                    closedByLabel: 'Luis',
                    openedAt: at('2026-10-05T14:00:00Z'),
                    closedAt: at('2026-10-05T22:00:00Z'),
                    openingAmount: 500,
                    expectedCashAmount: 2000,
                    countedCashAmount: 1950,
                    cashDifference: -50,
                    adjustmentStatus: null,
                },
            ],
        });

        const [session] = await toolResult('cash_sessions');

        expect(session).toMatchObject({ openedBy: 'Luis', expectedCash: 2000, difference: -50 });
    });

    it('stock bajo: el agotado primero y el límite se acota', async () => {
        listProducts.mockResolvedValue([
            { id: 'a', name: 'Aspirina', sku: 'A', salePrice: 10, minStock: 5, isActive: true },
            { id: 'b', name: 'Zinc', sku: 'Z', salePrice: 20, minStock: 4, isActive: true },
        ]);
        listBatchesWithStock.mockResolvedValue([{ productId: 'a', quantity: 2, costPrice: 1 }]);

        const all = await toolResult('low_stock');
        const clamped = await toolResult('low_stock', { limit: -5 });

        expect(all).toMatchObject({ total: 2, outOfStock: 1 });
        expect(all.products.map((product: { name: string }) => product.name)).toEqual([
            'Zinc',
            'Aspirina',
        ]);
        // Un límite negativo se sube a 1: el modelo no puede pedir "nada" ni "todo".
        expect(clamped.products).toHaveLength(1);
        expect(clamped.total).toBe(2);
    });
});
