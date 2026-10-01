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
}));
jest.mock('../src/services/insights.service', () => ({
    getSalesByHour: jest.fn(),
    getReorderSuggestions: jest.fn(),
}));
jest.mock('../src/services/inventory-alerts.service', () => ({ getInventoryAlerts: jest.fn() }));
jest.mock('../src/services/inventory-summary.service', () => ({
    getInventorySummary: jest.fn(),
}));

import { assistantChatSchema } from '../src/schemas/assistant';
import { chat } from '../src/services/assistant.service';

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
