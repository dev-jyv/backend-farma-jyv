import {
    breakdownLineTaxes,
    breakdownWithRates,
    prorateDiscount,
    resolveIepsRate,
    resolveIvaRate,
    sumTaxSummary,
    toCents,
} from '../src/utils/taxes';
import { buildCsv, escapeCsvValue } from '../src/utils/csv';

/**
 * Precios con impuestos incluidos: el invariante que importa es que el desglose
 * sume exactamente el importe cobrado. Un CFDI que no cuadra lo rechaza el PAC.
 */
describe('utils/taxes - breakdownLineTaxes', () => {
    it('desglosa IVA 16% de un precio con impuestos incluidos', () => {
        const taxes = breakdownLineTaxes({
            grossAmount: 116,
            hasIva: true,
            hasIvaZero: false,
            hasIeps: false,
        });

        expect(taxes.base).toBe(100);
        expect(taxes.ivaRate).toBe(0.16);
        expect(taxes.ivaAmount).toBe(16);
        expect(taxes.iepsAmount).toBe(0);
        expect(taxes.base + taxes.ivaAmount + taxes.iepsAmount).toBe(116);
    });

    it('trata el IVA cero de medicinas como base completa sin impuesto', () => {
        const taxes = breakdownLineTaxes({
            grossAmount: 250.5,
            hasIva: true,
            hasIvaZero: true,
            hasIeps: false,
        });

        expect(taxes.ivaRate).toBe(0);
        expect(taxes.ivaAmount).toBe(0);
        expect(taxes.base).toBe(250.5);
    });

    it('aplica IEPS antes de IVA (IVA sobre base + IEPS)', () => {
        // base 100 -> IEPS 8% = 8 -> IVA 16% sobre 108 = 17.28 -> total 125.28
        const taxes = breakdownLineTaxes({
            grossAmount: 125.28,
            hasIva: true,
            hasIvaZero: false,
            hasIeps: true,
            iepsRate: 0.08,
        });

        expect(taxes.base).toBe(100);
        expect(taxes.iepsAmount).toBe(8);
        expect(taxes.ivaAmount).toBe(17.28);
        expect(toCents(taxes.base + taxes.iepsAmount + taxes.ivaAmount)).toBe(toCents(125.28));
    });

    it('el desglose siempre suma el importe cobrado, incluso con centavos feos', () => {
        for (const gross of [0.99, 1.01, 7.77, 13.13, 99.95, 1234.56]) {
            const taxes = breakdownLineTaxes({
                grossAmount: gross,
                hasIva: true,
                hasIvaZero: false,
                hasIeps: true,
                iepsRate: 0.265,
            });
            expect(toCents(taxes.base + taxes.ivaAmount + taxes.iepsAmount))
                .toBe(toCents(gross));
        }
    });

    it('un producto con hasIeps sin tasa no inventa impuesto', () => {
        expect(resolveIepsRate({ hasIeps: true })).toBe(0);
        expect(resolveIepsRate({ hasIeps: false, iepsRate: 0.08 })).toBe(0);
        expect(resolveIvaRate({ hasIva: false, hasIvaZero: false })).toBe(0);
    });

    it('breakdownWithRates respeta las tasas dadas y no las del catálogo', () => {
        const taxes = breakdownWithRates({ grossAmount: 116, ivaRate: 0.16, iepsRate: 0 });
        expect(taxes.base).toBe(100);
        expect(taxes.ivaAmount).toBe(16);
    });
});

describe('utils/taxes - sumTaxSummary', () => {
    it('suma en centavos para no arrastrar error de punto flotante', () => {
        const ivaOnly = (grossAmount: number) => breakdownLineTaxes({
            grossAmount,
            hasIva: true,
            hasIvaZero: false,
            hasIeps: false,
        });
        const summary = sumTaxSummary([ivaOnly(0.1), ivaOnly(0.2)]);

        expect(summary.total).toBe(0.3);
        expect(toCents(summary.base + summary.taxTotal)).toBe(toCents(summary.total));
    });
});

describe('utils/taxes - prorateDiscount', () => {
    it('reparte proporcional al importe de cada partida', () => {
        const shares = prorateDiscount([100, 300], 40);
        expect(shares).toEqual([10, 30]);
    });

    it('el residuo de centavos va a la partida mayor y la suma es exacta', () => {
        const shares = prorateDiscount([10, 10, 10], 0.01);
        expect(toCents(shares.reduce((sum, share) => sum + share, 0))).toBe(1);
    });

    it('nunca reparte más que el importe de la partida', () => {
        const shares = prorateDiscount([5, 95], 100);
        expect(shares).toEqual([5, 95]);
    });

    it('sin descuento devuelve ceros', () => {
        expect(prorateDiscount([10, 20], 0)).toEqual([0, 0]);
    });
});

describe('utils/csv', () => {
    it('neutraliza fórmulas para que Excel no las ejecute', () => {
        expect(escapeCsvValue('=HYPERLINK("http://mal.example")'))
            .toBe('"\'=HYPERLINK(""http://mal.example"")"');
        expect(escapeCsvValue('+1')).toBe('\'+1');
        expect(escapeCsvValue('-1')).toBe('\'-1');
        expect(escapeCsvValue('@sum')).toBe('\'@sum');
    });

    it('entrecomilla y duplica comillas cuando hace falta', () => {
        expect(escapeCsvValue('Paracetamol, 500mg')).toBe('"Paracetamol, 500mg"');
        expect(escapeCsvValue('Lote "A"')).toBe('"Lote ""A"""');
        expect(escapeCsvValue('linea1\nlinea2')).toBe('"linea1\nlinea2"');
        expect(escapeCsvValue('simple')).toBe('simple');
    });

    it('vacío para null y undefined', () => {
        expect(escapeCsvValue(null)).toBe('');
        expect(escapeCsvValue(undefined)).toBe('');
        expect(escapeCsvValue(0)).toBe('0');
    });

    it('arma el archivo con BOM y CRLF', () => {
        const csv = buildCsv(['a', 'b'], [[1, 'x'], [2, 'y']]);
        expect(csv.startsWith('\ufeff')).toBe(true);
        expect(csv).toBe('\ufeffa,b\r\n1,x\r\n2,y\r\n');
    });
});
