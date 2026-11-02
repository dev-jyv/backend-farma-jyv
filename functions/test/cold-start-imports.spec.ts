/**
 * El arranque en frío de `api` no debe cargar la cadena de correo (SPEC 44 y
 * "Cost and cold start" del CLAUDE.md). `index.ts` reexporta las funciones
 * programadas y `app.module` arrastra todos los controllers y sus services: un
 * solo `import` estático de un service de envío mete Resend y React Email en
 * cada arranque de la API, que casi nunca manda correo.
 *
 * Cómo se mide: cada paquete vigilado se sustituye por un módulo falso que se
 * anota al **evaluarse**. Si tras cargar `src/index` (y con él `app.module`)
 * alguno se anotó, alguien lo importó de forma estática. El segundo caso
 * comprueba que la trampa funciona: cargar el sender sí los anota.
 */

const mockLoaded = new Set<string>();

jest.mock('resend', () => {
    mockLoaded.add('resend');
    return { Resend: jest.fn() };
});
jest.mock('@react-email/render', () => {
    mockLoaded.add('@react-email/render');
    return { render: jest.fn() };
});
jest.mock('@react-email/components', () => {
    mockLoaded.add('@react-email/components');
    return new Proxy({}, { get: () => () => null });
});

const WATCHED = ['resend', '@react-email/render', '@react-email/components'];

describe('grafo de imports del arranque de api', () => {
    beforeEach(() => {
        mockLoaded.clear();
        jest.resetModules();
    });

    it('index.ts y app.module no cargan resend ni @react-email/* de forma estática', async () => {
        await jest.isolateModulesAsync(async () => {
            await import('../src/index');
            await import('../src/app.module');
        });
        expect([...mockLoaded]).toEqual([]);
    });

    it('la trampa detecta la carga (el sender de alertas de cajas sí los trae)', async () => {
        await jest.isolateModulesAsync(async () => {
            await import('../src/services/pos-health-alerts-sender.service');
        });
        expect([...mockLoaded].sort()).toEqual([...WATCHED].sort());
    });
});
