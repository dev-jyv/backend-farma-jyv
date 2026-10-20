import { badRequest } from '../../utils/errors';
import {
    ReportRange,
    currentMonth,
    dateFormatter,
    dayRange,
    monthRange,
    periodBounds,
    todayYmd,
} from '../module-reports.service';
import { assertReportSpan, getMaxReportSpanDays } from '../../utils/report-range';
import { ExportQuery } from './report-definition';


/**
 * Periodo de un reporte. Prioridad: rango libre (`from`/`to`), un día (`date`) y
 * un mes (`month`); sin nada, el mes en curso.
 */
export const resolveReportPeriod = (
    query: ExportQuery,
    now: Date,
    maxDays: number = getMaxReportSpanDays('detail'),
): ReportRange => {
    if (query.from || query.to) {
        let bounds: { from: string; to: string };
        try {
            bounds = periodBounds(query.from, query.to, now);
        } catch (error) {
            throw badRequest((error as Error).message);
        }
        assertReportSpan(bounds.from, bounds.to, maxDays, now);
        const fromDate = new Date(bounds.from);
        const toDate = new Date(bounds.to);
        return {
            ...bounds,
            label: `${dateFormatter.format(fromDate)} al ${dateFormatter.format(toDate)}`,
            slug: `${todayYmd(fromDate)}_${todayYmd(toDate)}`,
        };
    }
    if (query.date) {
        return dayRange(query.date);
    }
    return monthRange(query.month ?? currentMonth(now));
};
