import { closeCashSessionSchema, openCashSessionSchema } from '../src/schemas/sales';

/**
 * El fondo con el que abre un turno hereda el efectivo que quedó del corte
 * anterior, y ese saldo puede quedar en rojo si se retiró más de lo que había
 * en el cajón. Recortarlo a cero no hacía aparecer el dinero: abría el turno
 * con un fondo falso y el faltante reaparecía en el arqueo siguiente.
 */
describe('openCashSessionSchema', () => {
    it('acepta un fondo negativo: es el saldo heredado', () => {
        const result = openCashSessionSchema.safeParse({ openingAmount: -150.5 });
        expect(result.success).toBe(true);
    });

    it('sigue aceptando cero y positivos', () => {
        expect(openCashSessionSchema.safeParse({ openingAmount: 0 }).success).toBe(true);
        expect(openCashSessionSchema.safeParse({ openingAmount: 1500 }).success).toBe(true);
    });

    it('el tope también aplica en negativo', () => {
        expect(openCashSessionSchema.safeParse({ openingAmount: -10_000_001 }).success).toBe(false);
    });

    it('rechaza más de dos decimales', () => {
        expect(openCashSessionSchema.safeParse({ openingAmount: -10.123 }).success).toBe(false);
    });
});

/**
 * El conteo también admite negativo: arrastra el fondo heredado —que ya puede
 * venir en rojo— y la caja acaba en números rojos si se gastó de más o si un
 * movimiento se registró mal.
 */
describe('closeCashSessionSchema', () => {
    it('acepta un conteo negativo: la caja puede quedar en rojo', () => {
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: -320.75 }).success).toBe(true);
    });

    it('acepta cerrar en cero y en positivo', () => {
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: 0 }).success).toBe(true);
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: 1200 }).success).toBe(true);
    });

    it('el tope y los dos decimales siguen aplicando', () => {
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: -10_000_001 }).success)
            .toBe(false);
        expect(closeCashSessionSchema.safeParse({ countedCashAmount: -1.005 }).success).toBe(false);
    });
});
