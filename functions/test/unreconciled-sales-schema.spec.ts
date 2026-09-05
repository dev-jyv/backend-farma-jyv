import { createUnreconciledSaleSchema } from '../src/schemas/sales';

/**
 * Venta cobrada en caja que el backend no pudo registrar. El POS la manda para
 * que el movimiento no se pierda; el documento se guarda con el `localId` como
 * id, así que reintentar el mismo push no duplica nada.
 */
describe('createUnreconciledSaleSchema', () => {
    const base = {
        localId: 'local-1',
        reason: 'Stock insuficiente para CORIVER',
        total: 100,
        payload: { idempotencyKey: 'key-1', items: [{ productId: 'p1', quantity: 1 }] },
    };

    it('acepta lo mínimo: de dónde viene, por qué y cuánto', () => {
        expect(createUnreconciledSaleSchema.safeParse(base).success).toBe(true);
    });

    it('acepta el folio provisional, el turno y la hora del cobro', () => {
        const result = createUnreconciledSaleSchema.safeParse({
            ...base,
            localFolio: 'PENDIENTE-1788467939952',
            cashSessionId: 's1',
            occurredAt: '2026-09-03T18:00:00.000Z',
        });
        expect(result.success).toBe(true);
    });

    it('exige el motivo: sin él el documento no explica nada', () => {
        expect(createUnreconciledSaleSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    });

    it('exige el vínculo con la venta de la caja', () => {
        const { localId, ...sinLocalId } = base;
        void localId;
        expect(createUnreconciledSaleSchema.safeParse(sinLocalId).success).toBe(false);
    });

    it('conserva el payload íntegro para poder reintentarlo a mano', () => {
        const result = createUnreconciledSaleSchema.parse(base);
        expect(result.payload).toEqual(base.payload);
    });
});
