import { Timestamp } from 'firebase-admin/firestore';
import { allocateFefo } from '../src/utils/fefo';
import { formatLocalDateTime } from '../src/utils/timezone';
import { calculateAge } from '../src/services/patients.service';
import { Batch } from '../src/types';

/**
 * La Function corre en UTC pero farmacia y consultorio viven en America/Mexico_City
 * (UTC-6, sin horario de verano). Entre las 18:00 y las 24:00 locales el día UTC ya
 * es el siguiente: estas pruebas fijan el instante a las 19:00 locales.
 */
const MX_EVENING = Date.parse('2026-10-21T01:00:00Z'); // 20 oct 2026, 19:00 en México

const batch = (expiry: string, quantity = 5): Batch => ({
    id: `b-${expiry}`,
    productId: 'p1',
    lotNumber: 'L1',
    expiryDate: Timestamp.fromDate(new Date(expiry)),
    quantity,
} as unknown as Batch);

describe('FEFO: caducidad en el día de la farmacia', () => {
    it('un lote que caduca hoy sigue vendible a las 19:00 hora de México', () => {
        const allocations = allocateFefo([batch('2026-10-20')], 1, {
            now: new Date(MX_EVENING),
        });
        expect(allocations).toHaveLength(1);
    });

    it('un lote que caducó ayer ya no se vende', () => {
        expect(() => allocateFefo([batch('2026-10-19')], 1, { now: new Date(MX_EVENING) }))
            .toThrow();
    });
});

describe('calculateAge: la edad cuenta con el día local', () => {
    const birthDate = Timestamp.fromDate(new Date('1990-10-21T00:00:00Z'));

    it('la víspera del cumpleaños (19:00 local) todavía no suma el año', () => {
        expect(calculateAge(birthDate, MX_EVENING)).toBe(35);
    });

    it('el día del cumpleaños suma el año', () => {
        expect(calculateAge(birthDate, Date.parse('2026-10-21T18:00:00Z'))).toBe(36);
    });
});

describe('formatLocalDateTime', () => {
    it('imprime la hora de México aunque el proceso esté en UTC', () => {
        const text = formatLocalDateTime(new Date(MX_EVENING));
        expect(text).toContain('20');
        expect(text).toMatch(/7:00:00|19:00:00/);
    });
});
