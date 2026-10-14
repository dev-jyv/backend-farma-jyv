/**
 * Chatbot de análisis del negocio.
 *
 * Se fija el ciclo de herramientas, no la calidad del modelo: que una petición de
 * herramienta se ejecute y su resultado vuelva al modelo, que una herramienta
 * inexistente o rota no tumbe la conversación y que el ciclo tenga tope (la
 * función vive 60 s). OpenRouter y los reportes se simulan; nada toca la red.
 */

const openRouterRequest = jest.fn();
jest.mock('../src/services/openrouter.service', () => ({ openRouterRequest }));

const getSalesSummary = jest.fn();
jest.mock('../src/services/analytics.service', () => ({
    getSalesSummary,
    getProfitReport: jest.fn(),
    getTopProducts: jest.fn(),
    getSalesByCashier: jest.fn(),
    getDeadStock: jest.fn(),
    getTopServices: jest.fn(),
    getCommissionsByProvider: jest.fn(),
}));
jest.mock('../src/services/insights.service', () => ({
    getSalesByHour: jest.fn(),
    getReorderSuggestions: jest.fn(),
}));
jest.mock('../src/services/inventory-alerts.service', () => ({ getInventoryAlerts: jest.fn() }));
jest.mock('../src/services/business-summary.service', () => ({
    getBusinessSummary: jest.fn(),
    scopeSummary: jest.fn((summary: unknown, scope: string) => ({ scope, summary })),
}));
jest.mock('../src/services/service-analytics.service', () => ({
    findServicesByName: jest.fn(),
    getServiceAnalytics: jest.fn(),
}));
jest.mock('../src/services/product-analytics.service', () => ({
    findProductsByName: jest.fn(),
    getProductAnalytics: jest.fn(),
    DEFAULT_ANALYTICS_MONTHS: 12,
    MAX_ANALYTICS_MONTHS: 24,
}));
jest.mock('../src/services/inventory-summary.service', () => ({
    getInventorySummary: jest.fn(),
}));

import { assistantChatSchema } from '../src/schemas/assistant';
import { chat } from '../src/services/assistant.service';
import { getBusinessSummary, scopeSummary } from '../src/services/business-summary.service';
import {
    findServicesByName,
    getServiceAnalytics,
} from '../src/services/service-analytics.service';
import {
    findProductsByName,
    getProductAnalytics,
} from '../src/services/product-analytics.service';

const toolCall = (name: string, args = '{}', id = 'call_1') => ({
    id,
    function: { name, arguments: args },
});

const askToCall = (...calls: ReturnType<typeof toolCall>[]) => ({
    model: 'test-model',
    choices: [{ message: { content: null, tool_calls: calls } }],
});

const answer = (content: string) => ({
    model: 'test-model',
    choices: [{ message: { content } }],
});

const history = [{ role: 'user' as const, content: '¿Cómo vamos este mes?' }];

describe('assistant.chat', () => {
    beforeEach(() => {
        openRouterRequest.mockReset();
        getSalesSummary.mockReset();
    });

    it('responde directo cuando el modelo no pide herramientas', async () => {
        openRouterRequest.mockResolvedValueOnce(answer('Todo bien.'));

        const result = await chat(history);

        expect(result).toEqual({ reply: 'Todo bien.', model: 'test-model', toolsUsed: [] });
        expect(openRouterRequest).toHaveBeenCalledTimes(1);
    });

    it('ejecuta la herramienta y le devuelve el resultado al modelo', async () => {
        getSalesSummary.mockResolvedValue({ totalAmount: 1234 });
        openRouterRequest
            .mockResolvedValueOnce(
                askToCall(toolCall('sales_summary', '{"from":"2026-10-01","to":"2026-10-31"}')),
            )
            .mockResolvedValueOnce(answer('Vendiste $1,234.'));

        const result = await chat(history);

        expect(getSalesSummary).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-31' });
        expect(result.reply).toBe('Vendiste $1,234.');
        expect(result.toolsUsed).toEqual(['sales_summary']);

        const secondCall = openRouterRequest.mock.calls[1][1];
        const toolMessage = secondCall.messages[secondCall.messages.length - 1];
        expect(toolMessage).toEqual({
            role: 'tool',
            tool_call_id: 'call_1',
            content: JSON.stringify({ totalAmount: 1234 }),
        });
    });

    it('una herramienta desconocida o que falla no tumba la conversación', async () => {
        getSalesSummary.mockRejectedValue(new Error('boom'));
        openRouterRequest
            .mockResolvedValueOnce(
                askToCall(
                    toolCall('no_existe', '{}', 'a'),
                    toolCall('sales_summary', 'no-es-json', 'b'),
                ),
            )
            .mockResolvedValueOnce(answer('No pude leer los datos.'));

        const result = await chat(history);

        expect(result.reply).toBe('No pude leer los datos.');
        const messages = openRouterRequest.mock.calls[1][1].messages;
        const toolResults = messages.filter((m: { role: string }) => m.role === 'tool');
        expect(toolResults[0].content).toContain('Herramienta desconocida');
        expect(toolResults[1].content).toContain('boom');
        // Argumentos que no son JSON se tratan como vacíos, no revientan.
        expect(getSalesSummary).toHaveBeenCalledWith({});
    });

    it('trunca resultados enormes antes de dárselos al modelo', async () => {
        getSalesSummary.mockResolvedValue({ blob: 'x'.repeat(50_000) });
        openRouterRequest
            .mockResolvedValueOnce(askToCall(toolCall('sales_summary')))
            .mockResolvedValueOnce(answer('ok'));

        await chat(history);

        const messages = openRouterRequest.mock.calls[1][1].messages;
        const toolMessage = messages[messages.length - 1];
        expect(toolMessage.content.length).toBeLessThan(13_000);
        expect(toolMessage.content).toContain('[truncado]');
    });

    it('corta el ciclo: la última ronda va sin herramientas', async () => {
        getSalesSummary.mockResolvedValue({});
        openRouterRequest.mockImplementation(async (_path, body) =>
            body.tools ? askToCall(toolCall('sales_summary')) : answer('Resumen final.'),
        );

        const result = await chat(history);

        expect(result.reply).toBe('Resumen final.');
        // 4 rondas con herramientas + 1 sin ellas.
        expect(openRouterRequest).toHaveBeenCalledTimes(5);
        expect(openRouterRequest.mock.calls[4][1].tools).toBeUndefined();
    });

    it('falla con 502 si el modelo responde vacío', async () => {
        openRouterRequest.mockResolvedValueOnce(answer('   '));

        await expect(chat(history)).rejects.toMatchObject({ statusCode: 502 });
    });
});

describe('assistantChatSchema', () => {
    it('exige que el último mensaje sea del usuario', () => {
        const result = assistantChatSchema.safeParse({
            messages: [
                { role: 'user', content: 'hola' },
                { role: 'assistant', content: 'hola' },
            ],
        });
        expect(result.success).toBe(false);
    });

    it('rechaza historial vacío, vacíos y demasiado largo', () => {
        expect(assistantChatSchema.safeParse({ messages: [] }).success).toBe(false);
        expect(
            assistantChatSchema.safeParse({ messages: [{ role: 'user', content: '  ' }] }).success,
        ).toBe(false);
        const many = Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' }));
        expect(assistantChatSchema.safeParse({ messages: many }).success).toBe(false);
    });

    it('acepta una conversación válida', () => {
        expect(
            assistantChatSchema.safeParse({
                messages: [
                    { role: 'user', content: 'hola' },
                    { role: 'assistant', content: 'qué tal' },
                    { role: 'user', content: 'ventas?' },
                ],
            }).success,
        ).toBe(true);
    });
});

describe('assistant: resumen y análisis de producto', () => {
    const lastToolMessage = () => {
        const call = openRouterRequest.mock.calls[1][1];
        return JSON.parse(call.messages[call.messages.length - 1].content);
    };

    beforeEach(() => {
        openRouterRequest.mockReset();
        (getBusinessSummary as jest.Mock).mockReset();
        (findProductsByName as jest.Mock).mockReset();
        (getProductAnalytics as jest.Mock).mockReset();
    });

    it('business_summary usa el periodo pedido y cae a semana si es inválido', async () => {
        (getBusinessSummary as jest.Mock).mockResolvedValue({ ok: true });
        openRouterRequest
            .mockResolvedValueOnce(askToCall(
                toolCall('business_summary', '{"period":"month","anchor":"2026-09-15"}', 'a'),
                toolCall('business_summary', '{"period":"year","anchor":"mañana"}', 'b'),
            ))
            .mockResolvedValueOnce(answer('listo'));

        await chat(history);

        expect(getBusinessSummary).toHaveBeenNthCalledWith(1, 'month', '2026-09-15');
        expect(getBusinessSummary).toHaveBeenNthCalledWith(2, 'week', undefined);
    });

    it('find_product y product_analytics encadenan el id y acotan los meses', async () => {
        (findProductsByName as jest.Mock).mockResolvedValue([{ id: 'p1', name: 'Paracetamol' }]);
        (getProductAnalytics as jest.Mock).mockResolvedValue({ product: { id: 'p1' } });
        openRouterRequest
            .mockResolvedValueOnce(askToCall(toolCall('find_product', '{"query":"parace"}', 'a')))
            .mockResolvedValueOnce(askToCall(
                toolCall('product_analytics', '{"productId":"p1","months":99}', 'b'),
            ))
            .mockResolvedValueOnce(answer('listo'));

        const result = await chat(history);

        expect(findProductsByName).toHaveBeenCalledWith('parace');
        expect(getProductAnalytics).toHaveBeenCalledWith('p1', 24);
        expect(result.toolsUsed).toEqual(['find_product', 'product_analytics']);
    });

    it('product_analytics sin productId devuelve el error sin tumbar el chat', async () => {
        openRouterRequest
            .mockResolvedValueOnce(askToCall(toolCall('product_analytics', '{}')))
            .mockResolvedValueOnce(answer('necesito el producto'));

        const result = await chat(history);

        expect(getProductAnalytics).not.toHaveBeenCalled();
        expect(lastToolMessage().error).toMatch(/find_product/);
        expect(result.reply).toBe('necesito el producto');
    });

    it('el prompt lleva la fecha de hoy calculada al momento de la conversación', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2031-05-17T15:00:00.000Z'));
        openRouterRequest.mockResolvedValueOnce(answer('ok'));

        await chat(history);
        jest.useRealTimers();

        const system = openRouterRequest.mock.calls[0][1].messages[0].content as string;
        expect(system).toContain('Hoy es 2031-05-17');
    });

    it('business_summary pasa el alcance y cae a "all" si es inválido', async () => {
        (getBusinessSummary as jest.Mock).mockResolvedValue({ ok: true });
        (scopeSummary as jest.Mock).mockClear();
        openRouterRequest
            .mockResolvedValueOnce(askToCall(
                toolCall('business_summary', '{"scope":"services"}', 'a'),
                toolCall('business_summary', '{"scope":"todo"}', 'b'),
            ))
            .mockResolvedValueOnce(answer('listo'));

        await chat(history);

        expect(scopeSummary).toHaveBeenNthCalledWith(1, { ok: true }, 'services');
        expect(scopeSummary).toHaveBeenNthCalledWith(2, { ok: true }, 'all');
    });

    it('find_service y service_analytics encadenan el id y acotan los meses', async () => {
        (findServicesByName as jest.Mock).mockResolvedValue([{ id: 's1', name: 'Consulta' }]);
        (getServiceAnalytics as jest.Mock).mockResolvedValue({ service: { id: 's1' } });
        openRouterRequest
            .mockResolvedValueOnce(askToCall(toolCall('find_service', '{"query":"consul"}', 'a')))
            .mockResolvedValueOnce(askToCall(
                toolCall('service_analytics', '{"serviceId":"s1","months":0}', 'b'),
            ))
            .mockResolvedValueOnce(answer('listo'));

        const result = await chat(history);

        expect(findServicesByName).toHaveBeenCalledWith('consul');
        expect(getServiceAnalytics).toHaveBeenCalledWith('s1', 12);
        expect(result.toolsUsed).toEqual(['find_service', 'service_analytics']);
    });

    it('service_analytics sin serviceId devuelve el error sin tumbar el chat', async () => {
        (getServiceAnalytics as jest.Mock).mockReset();
        openRouterRequest
            .mockResolvedValueOnce(askToCall(toolCall('service_analytics', '{}')))
            .mockResolvedValueOnce(answer('necesito el servicio'));

        const result = await chat(history);

        expect(getServiceAnalytics).not.toHaveBeenCalled();
        expect(lastToolMessage().error).toMatch(/find_service/);
        expect(result.reply).toBe('necesito el servicio');
    });
});
