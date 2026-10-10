import { createCashBoxMovementSchema } from '../src/schemas/sales';

/**
 * Cuerpo de la caja de la farmacia (`POST /cash-sessions/movements`, solo admin).
 * A diferencia de los movimientos del turno, aquí `cashSessionId` va en el
 * cuerpo y es opcional: el admin puede sacar efectivo sin turno abierto.
 */
describe('createCashBoxMovementSchema', () => {
    const base = { type: 'withdrawal' as const, amount: 200, reason: 'Depósito bancario' };

    it('acepta una salida sin turno', () => {
        const result = createCashBoxMovementSchema.safeParse(base);
        expect(result.success).toBe(true);
        expect(result.success && result.data.cashSessionId).toBeUndefined();
    });

    it('acepta una entrada aplicada a un turno abierto', () => {
        const result = createCashBoxMovementSchema.safeParse({
            ...base,
            type: 'deposit',
            cashSessionId: 's1',
        });
        expect(result.success).toBe(true);
    });

    /**
     * Los gastos llevan categoría y descripción obligatorias y viven en
     * `createCashMovementSchema`; dejarlos entrar por aquí los guardaría sin
     * categoría y descuadraría el desglose del corte.
     */
    it('rechaza un gasto: esa ruta es la del turno', () => {
        expect(createCashBoxMovementSchema.safeParse({ ...base, type: 'expense' }).success)
            .toBe(false);
    });

    it('rechaza monto cero o negativo', () => {
        expect(createCashBoxMovementSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
        expect(createCashBoxMovementSchema.safeParse({ ...base, amount: -50 }).success).toBe(false);
    });

    it('rechaza un motivo vacío: un retiro sin causa no se puede auditar', () => {
        expect(createCashBoxMovementSchema.safeParse({ ...base, reason: '   ' }).success)
            .toBe(false);
    });

    it('rechaza un turno vacío en vez de tratarlo como "sin turno"', () => {
        expect(createCashBoxMovementSchema.safeParse({ ...base, cashSessionId: '' }).success)
            .toBe(false);
    });
});
