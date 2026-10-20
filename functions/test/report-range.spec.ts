import {
    incomeStatementQuerySchema,
    commissionsQuerySchema,
    reportPeriodQuerySchema,
} from '../src/schemas';
import {
    getMaxReportSpanDays,
    reportSpanDays,
} from '../src/utils/report-range';

const message = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
    result.error?.issues[0]?.message;

describe('tope de rango de reportes', () => {
    afterEach(() => {
        delete process.env.REPORT_MAX_SPAN_DAYS;
        delete process.env.REPORT_MAX_SPAN_DAYS_FINANCIAL;
    });

    it('cuenta los días locales con ambos extremos incluidos', () => {
        expect(reportSpanDays('2026-01-01', '2026-04-03')).toBe(93);
        expect(reportSpanDays('2026-01-01', '2026-01-01')).toBe(1);
        // 00:00 y 23:59 de un día en México caen en el mismo día local, aunque en UTC no.
        expect(reportSpanDays('2026-03-01T06:00:00.000Z', '2026-03-02T05:59:59.999Z')).toBe(1);
    });

    it('un rango de 93 días se acepta', () => {
        const result = reportPeriodQuerySchema.safeParse({ from: '2026-01-01', to: '2026-04-03' });
        expect(result.success).toBe(true);
    });

    it('un rango de 94 días responde el máximo y el rango pedido', () => {
        const result = reportPeriodQuerySchema.safeParse({ from: '2026-01-01', to: '2026-04-04' });
        expect(result.success).toBe(false);
        expect(message(result)).toBe(
            'El rango máximo es de 93 días (el rango pedido es de 94 días)',
        );
    });

    it('las comisiones usan el mismo tope', () => {
        expect(commissionsQuerySchema.safeParse({ from: '2025-01-01', to: '2026-01-01' }).success)
            .toBe(false);
    });

    it('solo `to` lejano: `from` se completa con el valor por defecto antes de medir', () => {
        // from por defecto = hace 30 días; to en el pasado queda invertido (0 días) y no revienta.
        expect(reportPeriodQuerySchema.safeParse({ to: '2020-01-01' }).success).toBe(true);
        expect(reportPeriodQuerySchema.safeParse({}).success).toBe(true);
    });

    it('solo `from` muy antiguo se rechaza (to = ahora)', () => {
        expect(reportPeriodQuerySchema.safeParse({ from: '2020-01-01' }).success).toBe(false);
    });

    it('el estado de resultados admite hasta 366 días y rechaza 367', () => {
        const ok = incomeStatementQuerySchema.safeParse({
            from: '2026-01-01T06:00:00.000Z',
            to: '2026-12-31T05:59:59.999Z',
        });
        expect(ok.success).toBe(true);
        const long = incomeStatementQuerySchema.safeParse({
            from: '2025-01-01T06:00:00.000Z',
            to: '2026-01-03T05:59:59.999Z',
        });
        expect(long.success).toBe(false);
        expect(message(long)).toContain('El rango máximo es de 366 días');
    });

    it('el máximo se sobrescribe por variable de entorno', () => {
        process.env.REPORT_MAX_SPAN_DAYS = '10';
        expect(getMaxReportSpanDays('detail')).toBe(10);
        expect(reportPeriodQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-11' }).success)
            .toBe(false);
        process.env.REPORT_MAX_SPAN_DAYS_FINANCIAL = 'abc';
        expect(getMaxReportSpanDays('financial')).toBe(366);
    });
});
