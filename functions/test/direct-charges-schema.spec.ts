import {
    createDirectChargeSchema,
    createOnlineDirectChargeSchema,
    listDirectChargesQuerySchema,
} from '../src/schemas/direct-charges';
import { MAX_MONEY } from '../src/schemas/common';

/**
 * Contrato de entrada del cobro directo. Validación pura del schema: no toca
 * Firestore ni el emulador.
 *
 * Es la primera puerta del único módulo que mueve dinero sin una venta detrás,
 * así que lo que aquí pase llega a la terminal de Mercado Pago tal cual. Los dos
 * campos que importan son el monto (no negativo, no cero, no más de dos
 * decimales, con techo de cordura) y el concepto (es lo único que explica por
 * qué se cobró: sin él el cobro es indefendible ante una aclaración).
 */

const conTerminal = (overrides: Record<string, unknown> = {}) =>
    createDirectChargeSchema.safeParse({
        deviceId: 'NEWLAND_N950__X',
        amount: 150.5,
        concept: 'Consulta médica',
        ...overrides,
    });

const enLinea = (overrides: Record<string, unknown> = {}) =>
    createOnlineDirectChargeSchema.safeParse({
        amount: 150.5,
        concept: 'Consulta médica',
        ...overrides,
    });

describe('createDirectChargeSchema: monto', () => {
    it('acepta un monto con dos decimales', () => {
        const result = conTerminal({ amount: 99.99 });
        expect(result.success).toBe(true);
    });

    it('rechaza cero: no hay nada que cobrar', () => {
        expect(conTerminal({ amount: 0 }).success).toBe(false);
    });

    it('rechaza un monto negativo: sería un reembolso disfrazado de cobro', () => {
        expect(conTerminal({ amount: -50 }).success).toBe(false);
    });

    it('rechaza más de dos decimales: la terminal cobra centavos, no milésimas', () => {
        expect(conTerminal({ amount: 10.005 }).success).toBe(false);
    });

    it('rechaza NaN e Infinity', () => {
        expect(conTerminal({ amount: Number.NaN }).success).toBe(false);
        expect(conTerminal({ amount: Number.POSITIVE_INFINITY }).success).toBe(false);
    });

    it('rechaza un monto por encima del techo de cordura', () => {
        expect(conTerminal({ amount: MAX_MONEY }).success).toBe(true);
        expect(conTerminal({ amount: MAX_MONEY + 1 }).success).toBe(false);
    });

    it('rechaza el monto como texto: no se coacciona', () => {
        expect(conTerminal({ amount: '150.50' }).success).toBe(false);
    });

    it('exige el monto', () => {
        expect(createDirectChargeSchema.safeParse({
            deviceId: 'D1',
            concept: 'Consulta médica',
        }).success).toBe(false);
    });
});

describe('createDirectChargeSchema: concepto', () => {
    it('recorta los espacios alrededor', () => {
        const result = conTerminal({ concept: '  Consulta médica  ' });
        expect(result.success).toBe(true);
        expect(result.success && result.data.concept).toBe('Consulta médica');
    });

    it('rechaza el concepto vacío', () => {
        expect(conTerminal({ concept: '' }).success).toBe(false);
    });

    it('rechaza un concepto de puros espacios: al recortar no queda nada', () => {
        expect(conTerminal({ concept: '     ' }).success).toBe(false);
    });

    it('rechaza un concepto demasiado corto para explicar el cobro', () => {
        expect(conTerminal({ concept: 'ab' }).success).toBe(false);
        expect(conTerminal({ concept: 'abc' }).success).toBe(true);
    });

    it('rechaza un concepto de más de 150 caracteres', () => {
        expect(conTerminal({ concept: 'x'.repeat(150) }).success).toBe(true);
        expect(conTerminal({ concept: 'x'.repeat(151) }).success).toBe(false);
    });

    it('exige el concepto', () => {
        expect(createDirectChargeSchema.safeParse({ deviceId: 'D1', amount: 10 }).success)
            .toBe(false);
    });
});

describe('createDirectChargeSchema: terminal', () => {
    it('exige el identificador de la terminal', () => {
        expect(conTerminal({ deviceId: undefined }).success).toBe(false);
    });

    it('rechaza un deviceId vacío: sin terminal el cobro no tiene a dónde ir', () => {
        expect(conTerminal({ deviceId: '' }).success).toBe(false);
    });
});

describe('createDirectChargeSchema: llave de idempotencia', () => {
    it('es opcional', () => {
        expect(conTerminal({ idempotencyKey: undefined }).success).toBe(true);
    });

    it('trata null como ausente: es lo que manda el POS sin llave', () => {
        const result = conTerminal({ idempotencyKey: null });
        expect(result.success).toBe(true);
        expect(result.success && result.data.idempotencyKey).toBeUndefined();
    });

    it('acepta un uuid', () => {
        const result = conTerminal({ idempotencyKey: '6f1c0a2e-9a1b-4e3d-8f77-2b5c9d0e1a34' });
        expect(result.success).toBe(true);
    });

    it('rechaza una llave demasiado corta para ser única', () => {
        expect(conTerminal({ idempotencyKey: 'abc123' }).success).toBe(false);
    });

    it('rechaza una llave con caracteres que no viajan en un id de documento', () => {
        // La llave se usa como parte del id en `directChargeIdempotencyKeys`.
        expect(conTerminal({ idempotencyKey: 'llave/con/barras' }).success).toBe(false);
        expect(conTerminal({ idempotencyKey: 'llave con espacios' }).success).toBe(false);
    });

    it('rechaza una llave de más de 64 caracteres', () => {
        expect(conTerminal({ idempotencyKey: 'a'.repeat(64) }).success).toBe(true);
        expect(conTerminal({ idempotencyKey: 'a'.repeat(65) }).success).toBe(false);
    });
});

describe('createOnlineDirectChargeSchema', () => {
    it('acepta monto y concepto sin terminal', () => {
        const result = enLinea();
        expect(result.success).toBe(true);
    });

    it('no exige deviceId: el cobro en línea no pasa por una terminal', () => {
        expect(enLinea({ deviceId: undefined }).success).toBe(true);
    });

    it('aplica las mismas reglas de monto y concepto que el cobro con terminal', () => {
        expect(enLinea({ amount: 0 }).success).toBe(false);
        expect(enLinea({ amount: -1 }).success).toBe(false);
        expect(enLinea({ amount: 1.005 }).success).toBe(false);
        expect(enLinea({ amount: MAX_MONEY + 1 }).success).toBe(false);
        expect(enLinea({ concept: '  ' }).success).toBe(false);
        expect(enLinea({ concept: 'x'.repeat(151) }).success).toBe(false);
    });
});

describe('listDirectChargesQuerySchema', () => {
    it('acepta la consulta vacía: la lista tiene ventana por defecto', () => {
        expect(listDirectChargesQuerySchema.safeParse({}).success).toBe(true);
    });

    it('acepta los estados del cobro y rechaza cualquier otro', () => {
        for (const status of ['pending', 'approved', 'failed', 'canceled']) {
            expect(listDirectChargesQuerySchema.safeParse({ status }).success).toBe(true);
        }
        expect(listDirectChargesQuerySchema.safeParse({ status: 'refunded' }).success).toBe(false);
        expect(listDirectChargesQuerySchema.safeParse({ status: '' }).success).toBe(false);
    });

    it('acepta los dos canales y rechaza cualquier otro', () => {
        expect(listDirectChargesQuerySchema.safeParse({ channel: 'point' }).success).toBe(true);
        expect(listDirectChargesQuerySchema.safeParse({ channel: 'online' }).success).toBe(true);
        expect(listDirectChargesQuerySchema.safeParse({ channel: 'cash' }).success).toBe(false);
    });

    it('rechaza una fecha que no se puede interpretar', () => {
        expect(listDirectChargesQuerySchema.safeParse({ from: '2026-13-45' }).success).toBe(false);
        expect(listDirectChargesQuerySchema.safeParse({ from: 'ayer' }).success).toBe(false);
        expect(listDirectChargesQuerySchema.safeParse({ from: '2026-09-01' }).success).toBe(true);
    });

    it('acepta paginación y búsqueda como texto (llegan del query string)', () => {
        const result = listDirectChargesQuerySchema.safeParse({
            page: '2',
            limit: '25',
            search: 'CD-000001',
        });
        expect(result.success).toBe(true);
    });
});
