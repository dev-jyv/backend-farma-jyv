import 'reflect-metadata';
import { PERMISSION_KEY } from '../src/modules/identity/decorators/require-permission.decorator';
import { InvoiceRagController } from '../src/modules/invoice-rag/invoice-rag.controller';
import { invoiceRagDataSchema, invoiceRagEmbedSchema } from '../src/schemas/invoice-rag';
import {
    embedText,
    extractInvoiceData,
    parseExtraction,
} from '../src/services/invoice-rag.service';
import { AuthUser } from '../src/types';
import { UploadedFile } from '../src/types/uploads';
import { AppError } from '../src/utils/errors';
import { RateLimiter } from '../src/utils/rate-limiter';

/**
 * Facturas-RAG: proxy a OpenRouter. Todo es puro (se sustituye `fetch`): no
 * toca Firestore ni gasta créditos reales.
 */

type Captured = { url: string; init: RequestInit; body: Record<string, unknown> };

const originalFetch = global.fetch;
let calls: Captured[] = [];

const mockFetch = (status: number, body: unknown): void => {
    global.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
        return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
};

const chatResponse = (content: unknown) => ({
    model: 'google/gemini-2.5-flash',
    choices: [{ message: { content } }],
});

const file = (mimetype: string, content = 'contenido'): UploadedFile => ({
    fieldname: 'file',
    originalname: mimetype === 'application/pdf' ? 'cfe.pdf' : 'ticket.png',
    encoding: '7bit',
    mimetype,
    size: content.length,
    buffer: Buffer.from(content),
});

const expectAppError = async (promise: Promise<unknown>, statusCode: number, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await promise.catch((error: AppError) => {
        expect(error.statusCode).toBe(statusCode);
        expect(error.code).toBe(code);
    });
};

const base64 = (text: string): string => Buffer.from(text).toString('base64');

const userContentOf = (call: Captured): unknown[] =>
    (call.body.messages as { content: unknown[] }[])[1].content;

const VALID_JSON = {
    documentType: 'invoice',
    confidence: 0.92,
    issuer: { name: 'CFE Suministrador', rfc: 'css160330cp7' },
    receiver: { name: 'Farmacia JyV', rfc: null },
    folio: 'A-123',
    cfdiUuid: '6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
    issueDate: '2026-09-01',
    currency: 'mxn',
    paymentMethod: 'PUE',
    subtotal: 413.79,
    taxes: [{ type: 'IVA', rate: 0.16, amount: 66.21 }],
    total: 480,
    items: [{ description: 'Suministro', quantity: 1, unitPrice: 413.79, amount: 413.79 }],
    notes: null,
};

beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    delete process.env.OPENROUTER_VISION_MODEL;
    delete process.env.OPENROUTER_EMBED_MODEL;
    calls = [];
});

afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OPENROUTER_API_KEY;
});

describe('invoiceRagDataSchema', () => {
    it('normaliza RFC, UUID y moneda a mayúsculas', () => {
        const data = invoiceRagDataSchema.parse(VALID_JSON);
        expect(data.issuer.rfc).toBe('CSS160330CP7');
        expect(data.cfdiUuid).toBe('6F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B');
        expect(data.currency).toBe('MXN');
    });

    it('degrada lo ilegible a null en vez de rechazar el documento', () => {
        const data = invoiceRagDataSchema.parse({
            documentType: 'menu',
            confidence: 7,
            issuer: 'CFE',
            total: '$1,234.50',
            subtotal: 'n/a',
            issueDate: '01/09/2026',
            cfdiUuid: 'no-es-uuid',
            taxes: [{ type: 'IVA', amount: '16' }, 'basura'],
            items: 'nada',
        });
        expect(data).toMatchObject({
            documentType: 'other',
            confidence: 1,
            issuer: { name: null, rfc: null },
            receiver: { name: null, rfc: null },
            total: 1234.5,
            subtotal: null,
            issueDate: null,
            cfdiUuid: null,
            taxes: [{ type: 'IVA', rate: null, amount: 16 }],
            items: [],
            folio: null,
            notes: null,
        });
    });

    it('acota partidas para que un documento enorme no infle la respuesta', () => {
        const items = Array.from({ length: 500 }, (_, i) => ({ description: `p${i}`, amount: i }));
        expect(invoiceRagDataSchema.parse({ items }).items).toHaveLength(200);
    });
});

describe('invoiceRagEmbedSchema', () => {
    it('exige texto no vacío y con tope de longitud', () => {
        expect(() => invoiceRagEmbedSchema.parse({ text: '   ' })).toThrow();
        expect(() => invoiceRagEmbedSchema.parse({ text: 'x'.repeat(8001) })).toThrow();
        expect(invoiceRagEmbedSchema.parse({ text: ' factura ' })).toEqual({ text: 'factura' });
    });
});

describe('parseExtraction', () => {
    it('acepta JSON envuelto en bloque de código', () => {
        const data = parseExtraction('```json\n' + JSON.stringify(VALID_JSON) + '\n```');
        expect(data.total).toBe(480);
    });

    it.each([[null], [''], ['no es json']])('rechaza salida inválida (%p) con 502', (content) => {
        try {
            parseExtraction(content);
            throw new Error('debió fallar');
        } catch (error) {
            expect((error as AppError).code).toBe('INVOICE_RAG_INVALID_OUTPUT');
        }
    });
});

describe('extractInvoiceData', () => {
    it('manda la imagen como data URL, json_schema estricto y la llave del backend', async () => {
        mockFetch(200, chatResponse(JSON.stringify(VALID_JSON)));

        const result = await extractInvoiceData(file('image/png'));

        expect(result.model).toBe('google/gemini-2.5-flash');
        expect(result.data.documentType).toBe('invoice');
        const [call] = calls;
        expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
        const headers = call.init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer sk-or-test');
        expect(call.body).toMatchObject({
            model: 'google/gemini-2.5-flash',
            temperature: 0,
            response_format: { type: 'json_schema', json_schema: { strict: true } },
            provider: { require_parameters: true },
        });
        const userContent = userContentOf(call);
        expect(userContent[1]).toEqual({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64('contenido')}` },
        });
    });

    it('manda el PDF como parte file y respeta el modelo configurado', async () => {
        process.env.OPENROUTER_VISION_MODEL = 'anthropic/claude-sonnet-4.5';
        mockFetch(200, { choices: [{ message: { content: JSON.stringify(VALID_JSON) } }] });

        const result = await extractInvoiceData(file('application/pdf', '%PDF-1.7'));

        expect(result.model).toBe('anthropic/claude-sonnet-4.5');
        const userContent = userContentOf(calls[0]);
        expect(userContent[1]).toMatchObject({ type: 'file', file: { filename: 'cfe.pdf' } });
    });

    it('sin llave responde 503 y no llama a OpenRouter', async () => {
        delete process.env.OPENROUTER_API_KEY;
        mockFetch(200, {});
        await expectAppError(
            extractInvoiceData(file('image/png')),
            503,
            'OPENROUTER_NOT_CONFIGURED',
        );
        expect(calls).toHaveLength(0);
    });

    it.each([
        [401, 502, 'OPENROUTER_AUTH'],
        [402, 502, 'OPENROUTER_CREDITS'],
        [429, 429, 'OPENROUTER_RATE_LIMIT'],
        [500, 502, 'OPENROUTER_ERROR'],
    ])('traduce HTTP %i de OpenRouter a %i %s', async (status, expected, code) => {
        mockFetch(status, { error: { message: 'x' } });
        await expectAppError(extractInvoiceData(file('image/png')), expected, code);
    });

    it('un timeout se reporta como 504', async () => {
        global.fetch = (async () => {
            const error = new Error('timeout');
            error.name = 'TimeoutError';
            throw error;
        }) as unknown as typeof fetch;
        await expectAppError(extractInvoiceData(file('image/png')), 504, 'OPENROUTER_UNAVAILABLE');
    });
});

describe('embedText', () => {
    it('devuelve modelo, dimensiones y vector', async () => {
        mockFetch(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });

        await expect(embedText('Factura CFE')).resolves.toEqual({
            model: 'openai/text-embedding-3-small',
            dims: 3,
            vector: [0.1, 0.2, 0.3],
        });
        expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
        expect(calls[0].body).toEqual({
            model: 'openai/text-embedding-3-small',
            input: 'Factura CFE',
        });
    });

    it('rechaza un embedding vacío o no numérico', async () => {
        mockFetch(200, { data: [{ embedding: ['a'] }] });
        await expectAppError(embedText('x'), 502, 'INVOICE_RAG_INVALID_EMBEDDING');
    });
});

describe('RateLimiter', () => {
    it('corta al llegar al límite y libera al salir de la ventana', () => {
        const limiter = new RateLimiter(2, 1000);
        expect(limiter.tryConsume('u1', 0)).toBe(true);
        expect(limiter.tryConsume('u1', 10)).toBe(true);
        expect(limiter.tryConsume('u1', 20)).toBe(false);
        expect(limiter.tryConsume('u2', 20)).toBe(true);
        expect(limiter.tryConsume('u1', 1001)).toBe(true);
    });
});

describe('InvoiceRagController', () => {
    const user = { uid: 'uid-rate' } as AuthUser;

    it('exige invoices:write en ambos endpoints', () => {
        const proto = InvoiceRagController.prototype;
        for (const handler of [proto.extract, proto.embed]) {
            expect(Reflect.getMetadata(PERMISSION_KEY, handler))
                .toEqual({ area: 'invoices', level: 'write' });
        }
    });

    it('limita las extracciones por usuario', async () => {
        mockFetch(200, chatResponse(JSON.stringify(VALID_JSON)));
        const controller = new InvoiceRagController();
        const req = { file: file('image/png') } as never;
        for (let i = 0; i < 20; i += 1) {
            await controller.extract(req, user);
        }
        await expectAppError(controller.extract(req, user), 429, 'RATE_LIMITED');
    });

    it('sin archivo responde 400', async () => {
        await expectAppError(
            new InvoiceRagController().extract({} as never, { uid: 'otro' } as AuthUser),
            400,
            'BAD_REQUEST',
        );
    });
});
