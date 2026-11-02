import { Timestamp } from 'firebase-admin/firestore';
import { comparePitrVersions, parseDocPath, parsePitrReadTime } from '../src/utils/pitr';

/**
 * Reglas de la recuperación por PITR (SPEC 31). Una marca mal interpretada
 * reescribe producción con la versión equivocada, así que se valida antes de leer.
 */

const NOW = new Date('2026-11-02T18:30:00.000Z');

describe('parsePitrReadTime', () => {
    it('acepta un minuto entero dentro de la ventana de 7 días', () => {
        expect(parsePitrReadTime('2026-10-30T15:04:00Z', NOW).toISOString())
            .toBe('2026-10-30T15:04:00.000Z');
        expect(parsePitrReadTime('2026-10-30T09:04:00-06:00', NOW).toISOString())
            .toBe('2026-10-30T15:04:00.000Z');
    });

    it('en la última hora acepta segundos', () => {
        expect(parsePitrReadTime('2026-11-02T18:10:27Z', NOW).getUTCSeconds()).toBe(27);
    });

    it('rechaza marcas sin zona, futuras, fuera de 7 días o con segundos viejos', () => {
        expect(() => parsePitrReadTime('2026-10-30T15:04:00', NOW)).toThrow('zona explícita');
        expect(() => parsePitrReadTime('2026-11-02T19:00:00Z', NOW)).toThrow('futuro');
        expect(() => parsePitrReadTime('2026-10-26T18:00:00Z', NOW)).toThrow('bucket externo');
        expect(() => parsePitrReadTime('2026-10-30T15:04:30Z', NOW)).toThrow('minutos enteros');
        expect(() => parsePitrReadTime('ayerZ', NOW)).toThrow('no es una fecha válida');
    });
});

describe('parseDocPath', () => {
    it('acepta colección/id y subcolecciones', () => {
        expect(parseDocPath('/sales/abc/')).toBe('sales/abc');
        expect(parseDocPath('customers/c1/notes/n1')).toBe('customers/c1/notes/n1');
    });

    it('rechaza rutas de colección o con segmentos vacíos', () => {
        expect(() => parseDocPath('sales')).toThrow('colección/id');
        expect(() => parseDocPath('sales//abc/x')).toThrow('colección/id');
    });
});

describe('comparePitrVersions', () => {
    it('distingue sin cambios, cambios por campo, borrado y alta posterior', () => {
        const ts = Timestamp.fromMillis(1_700_000_000_000);
        expect(comparePitrVersions({ a: 1, at: ts, nested: { y: 1, x: 2 } }, {
            nested: { x: 2, y: 1 }, at: Timestamp.fromMillis(1_700_000_000_000), a: 1,
        })).toEqual({ kind: 'unchanged' });

        expect(comparePitrVersions(
            { totalStock: 10, name: 'X', at: ts },
            { totalStock: 4, name: 'X', at: Timestamp.fromMillis(1_700_000_000_001), extra: true },
        )).toEqual({ kind: 'changed', fields: ['at', 'extra', 'totalStock'] });

        expect(comparePitrVersions({ a: 1 }, undefined)).toEqual({ kind: 'deleted_since' });
        expect(comparePitrVersions(undefined, { a: 1 })).toEqual({ kind: 'created_since' });
        expect(comparePitrVersions(undefined, undefined)).toEqual({ kind: 'absent' });
    });

    it('compara referencias por ruta sin recorrer el cliente', () => {
        const ref = (path: string) => ({ path, firestore: { circular: null as unknown } });
        const circular = ref('products/p1');
        circular.firestore.circular = circular;
        expect(comparePitrVersions({ product: circular }, { product: ref('products/p1') }))
            .toEqual({ kind: 'unchanged' });
        expect(comparePitrVersions({ product: circular }, { product: ref('products/p2') }))
            .toEqual({ kind: 'changed', fields: ['product'] });
    });
});
