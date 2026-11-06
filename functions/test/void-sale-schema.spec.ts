import { LEGACY_VOID_REASON, voidSaleSchema } from '../src/schemas/sales';

/**
 * Cuerpo de la anulación. Solo lo manda el POS al cerrar una anulación que
 * ocurrió sin red; en el camino normal el cuerpo va vacío.
 */
describe('voidSaleSchema', () => {
    it('acepta una anulación en línea, sin cuerpo (POS anterior: motivo por defecto)', () => {
        expect(voidSaleSchema.safeParse(undefined).success).toBe(true);
        const parsed = voidSaleSchema.parse({});
        expect(parsed.reason).toBe(LEGACY_VOID_REASON);
        expect(parsed.reasonDefaulted).toBe(true);
    });

    it('SPEC 62: acepta el motivo de 5 a 300 caracteres, recortado', () => {
        const parsed = voidSaleSchema.parse({ reason: '  Cliente desistió  ' });
        expect(parsed.reason).toBe('Cliente desistió');
        expect(parsed.reasonDefaulted).toBe(false);
        expect(voidSaleSchema.safeParse({ reason: 'x'.repeat(300) }).success).toBe(true);
    });

    it('SPEC 62: un payload nuevo con motivo vacío, corto, largo o null se rechaza', () => {
        for (const reason of ['', '    ', 'abc', 'x'.repeat(301), null, 12345]) {
            expect(voidSaleSchema.safeParse({ reason }).success).toBe(false);
        }
    });

    it('acepta el instante y el cajero reportados por la caja', () => {
        const result = voidSaleSchema.safeParse({
            voidedAt: '2026-09-03T18:20:00.000Z',
            voidedBy: 'u9',
        });
        expect(result.success).toBe(true);
    });

    it('rechaza una fecha que no lo es', () => {
        expect(voidSaleSchema.safeParse({ voidedAt: 'ayer' }).success).toBe(false);
    });

    it('rechaza un uid vacío', () => {
        expect(voidSaleSchema.safeParse({ voidedBy: '' }).success).toBe(false);
    });
});
