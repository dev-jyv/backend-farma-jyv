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
import { ExportQuery } from './report-definition';

/** Los reportes agregan en memoria: un rango sin tope es una función sin memoria. */
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Periodo de un reporte. Prioridad: rango libre (`from`/`to`), un día (`date`) y
 * un mes (`month`); sin nada, el mes en curso.
 */
export const resolveReportPeriod = (query: ExportQuery, now: Date): ReportRange => {
    if (query.from || query.to) {
        let bounds: { from: string; to: string };
        try {
            bounds = periodBounds(query.from, query.to, now);
        } catch (error) {
            throw badRequest((error as Error).message);
        }
        if ((Date.parse(bounds.to) - Date.parse(bounds.from)) / DAY_MS > MAX_RANGE_DAYS) {
            throw badRequest(`El rango no puede exceder ${MAX_RANGE_DAYS} días.`);
        }
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
