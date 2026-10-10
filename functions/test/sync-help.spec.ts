/**
 * Ayuda con IA para registros atorados al sincronizar.
 *
 * Se fija el contrato, no la calidad del modelo: solo se aceptan acciones de la
 * lista cerrada (nunca "descartar"), una respuesta mal formada no llega al POS
 * como si fuera buena, y lo que se manda al modelo es el resumen, nada más.
 */

const openRouterRequest = jest.fn();
jest.mock('../src/services/openrouter.service', () => ({ openRouterRequest }));

import { syncHelpSchema } from '../src/schemas/assistant';
import { syncHelp } from '../src/services/sync-help.service';

const answer = (content: string) => ({ model: 'test-model', choices: [{ message: { content } }] });

const input = {
    kind: 'sale' as const,
    code: 'desconocido',
    reason: 'Internal error 0x55',
};

describe('syncHelp', () => {
    beforeEach(() => openRouterRequest.mockReset());

    it('devuelve la explicación y los pasos validados', async () => {
        openRouterRequest.mockResolvedValue(
            answer(
                '{"explicacion":"Reintenta con red.","pasos":["reintentar"],"avisarAdmin":false}',
            ),
        );

        await expect(syncHelp(input)).resolves.toEqual({
            explicacion: 'Reintenta con red.',
            pasos: ['reintentar'],
            avisarAdmin: false,
            model: 'test-model',
        });
    });

    it('tolera el JSON envuelto en un bloque de código', async () => {
        openRouterRequest.mockResolvedValue(
            answer('```json\n{"explicacion":"x","pasos":[],"avisarAdmin":true}\n```'),
        );

        await expect(syncHelp(input)).resolves.toMatchObject({ avisarAdmin: true });
    });

    it('rechaza una acción fuera de la lista (p. ej. descartar)', async () => {
        openRouterRequest.mockResolvedValue(
            answer('{"explicacion":"Bórrala.","pasos":["descartar"],"avisarAdmin":false}'),
        );

        await expect(syncHelp(input)).rejects.toMatchObject({ statusCode: 502 });
    });

    it('rechaza texto que no es JSON', async () => {
        openRouterRequest.mockResolvedValue(answer('Reintenta más tarde.'));

        await expect(syncHelp(input)).rejects.toMatchObject({ statusCode: 502 });
    });

    it('rechaza una respuesta vacía', async () => {
        openRouterRequest.mockResolvedValue({ choices: [{ message: { content: '' } }] });

        await expect(syncHelp(input)).rejects.toMatchObject({ statusCode: 502 });
    });

    it('manda al modelo solo el resumen del registro, sin herramientas', async () => {
        openRouterRequest.mockResolvedValue(
            answer('{"explicacion":"x","pasos":[],"avisarAdmin":true}'),
        );

        await syncHelp({ ...input, dependency: { kind: 'product', label: 'Jarabe' } });

        const [, body] = openRouterRequest.mock.calls[0];
        expect(body.tools).toBeUndefined();
        const user = JSON.parse(body.messages[1].content);
        expect(Object.keys(user).sort()).toEqual(
            ['codigoDiagnostico', 'dependencia', 'motivo', 'tipo', 'versionApp'].sort(),
        );
    });
});

describe('syncHelpSchema', () => {
    it('no deja pasar un motivo enorme', () => {
        expect(syncHelpSchema.safeParse({ ...input, reason: 'x'.repeat(501) }).success).toBe(false);
    });

    it('no acepta campos de más (cliente, partidas)', () => {
        const parsed = syncHelpSchema.parse({ ...input, customer: 'Juan', items: [] } as never);
        expect(parsed).not.toHaveProperty('customer');
        expect(parsed).not.toHaveProperty('items');
    });
});
