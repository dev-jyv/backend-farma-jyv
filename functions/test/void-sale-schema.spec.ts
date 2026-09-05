import { voidSaleSchema } from '../src/schemas/sales';

/**
 * Cuerpo de la anulación. Solo lo manda el POS al cerrar una anulación que
 * ocurrió sin red; en el camino normal el cuerpo va vacío.
 */
describe('voidSaleSchema', () => {
    it('acepta una anulación en línea, sin cuerpo', () => {
        expect(voidSaleSchema.safeParse(undefined).success).toBe(true);
        expect(voidSaleSchema.safeParse({}).success).toBe(true);
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
