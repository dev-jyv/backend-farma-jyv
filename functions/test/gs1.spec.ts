import {
    gtinToBarcode,
    looksLikeGs1,
    parseGs1,
    parseGs1Date,
} from '../src/utils/gs1';

const FNC1 = String.fromCharCode(29);

describe('utils/gs1 - parseGs1Date', () => {
    const reference = new Date('2026-08-03T00:00:00Z');

    it('convierte YYMMDD a YYYY-MM-DD', () => {
        expect(parseGs1Date('270630', reference)).toBe('2027-06-30');
    });

    it('día 00 significa fin de mes (común en caducidades)', () => {
        expect(parseGs1Date('270200', reference)).toBe('2027-02-28');
        expect(parseGs1Date('280200', reference)).toBe('2028-02-29');
    });

    it('resuelve el siglo con la ventana de 50 años de GS1', () => {
        expect(parseGs1Date('990101', reference)).toBe('1999-01-01');
        expect(parseGs1Date('300101', reference)).toBe('2030-01-01');
    });

    it('rechaza fechas imposibles', () => {
        expect(parseGs1Date('271332', reference)).toBeNull();
        expect(parseGs1Date('270231', reference)).toBeNull();
        expect(parseGs1Date('27063', reference)).toBeNull();
    });
});

describe('utils/gs1 - parseGs1', () => {
    it('parsea GTIN + lote variable + caducidad con separador FNC1', () => {
        const result = parseGs1(`]d2010750123456789010ABC-123${FNC1}17270630`);

        expect(result.gtin).toBe('07501234567890');
        expect(result.barcode).toBe('7501234567890');
        expect(result.lotNumber).toBe('ABC-123');
        expect(result.expiryDate).toBe('2027-06-30');
    });

    it('parsea la forma con AI entre paréntesis', () => {
        const result = parseGs1('(01)07501234567890(17)271231(10)L-99(30)12');

        expect(result.barcode).toBe('7501234567890');
        expect(result.expiryDate).toBe('2027-12-31');
        expect(result.lotNumber).toBe('L-99');
        expect(result.quantity).toBe(12);
    });

    it('lee AI de longitud fija concatenados sin separador', () => {
        const result = parseGs1('010750123456789017271130');

        expect(result.gtin).toBe('07501234567890');
        expect(result.expiryDate).toBe('2027-11-30');
        expect(result.lotNumber).toBeNull();
    });

    it('extrae el serial y conserva los AI crudos', () => {
        const result = parseGs1(`010750123456789021SER-77${FNC1}10LOT-1`);

        expect(result.serial).toBe('SER-77');
        expect(result.lotNumber).toBe('LOT-1');
        expect(result.elements['21']).toBe('SER-77');
    });

    it('un EAN-13 pelón no se confunde con GS1', () => {
        expect(looksLikeGs1('7501234567890')).toBe(false);
        expect(looksLikeGs1(`010750123456789010L1${FNC1}`)).toBe(true);
        expect(looksLikeGs1('(01)07501234567890')).toBe(true);
    });

    it('normaliza GTIN-14 a EAN-13 quitando el cero de indicador', () => {
        expect(gtinToBarcode('07501234567890')).toBe('7501234567890');
        expect(gtinToBarcode('17501234567890')).toBe('17501234567890');
    });
});
