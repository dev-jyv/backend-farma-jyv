import { z } from 'zod';
import { badRequest } from './errors';
import { getZonedYmd } from './timezone';

/**
 * Tope de rango de los reportes. Cada día del rango cuesta lecturas de ventas
 * (una por venta), así que ningún reporte o exporte lee un periodo sin límite.
 *
 * - `detail`: reportes de detalle y analítica (93 días, un trimestre).
 * - `financial`: estados financieros y exportes anuales (366 días).
 *
 * Ambos se sobrescriben con `REPORT_MAX_SPAN_DAYS` y
 * `REPORT_MAX_SPAN_DAYS_FINANCIAL` (entero positivo) sin redesplegar código.
 */
export type ReportSpanKind = 'detail' | 'financial';

export const DEFAULT_MAX_REPORT_SPAN_DAYS = 93;
export const DEFAULT_MAX_FINANCIAL_SPAN_DAYS = 366;

/** Mismo valor por defecto que usa el repositorio de ventas cuando falta `from`. */
const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_TIME_ZONE = 'America/Mexico_City';

const readEnvDays = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const getMaxReportSpanDays = (kind: ReportSpanKind = 'detail'): number =>
    kind === 'financial'
        ? readEnvDays('REPORT_MAX_SPAN_DAYS_FINANCIAL', DEFAULT_MAX_FINANCIAL_SPAN_DAYS)
        : readEnvDays('REPORT_MAX_SPAN_DAYS', DEFAULT_MAX_REPORT_SPAN_DAYS);

/** Día local de México (`YYYY-MM-DD`); una fecha pelada ya es ese día. */
const localYmd = (value: string): string =>
    BARE_DATE.test(value) ? value : getZonedYmd(Date.parse(value), REPORT_TIME_ZONE);

const ymdToUtcMs = (ymd: string): number => {
    const [year, month, day] = ymd.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
};

/**
 * Días locales que abarca el rango, ambos extremos incluidos. Un extremo
 * ausente se completa como lo hace la lectura: `from` = hoy - 30 días y
 * `to` = ahora. Un rango invertido mide 0.
 */
export const reportSpanDays = (from?: string, to?: string, now = new Date()): number => {
    const defaultFrom = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
    const start = localYmd(from ?? defaultFrom);
    const end = localYmd(to ?? now.toISOString());
    return Math.max(0, Math.round((ymdToUtcMs(end) - ymdToUtcMs(start)) / DAY_MS) + 1);
};

/** Mensaje de error si el rango excede el máximo; `null` si cabe. */
export const reportSpanError = (
    from: string | undefined,
    to: string | undefined,
    maxDays: number,
    now = new Date(),
): string | null => {
    const span = reportSpanDays(from, to, now);
    return span > maxDays
        ? `El rango máximo es de ${maxDays} días (el rango pedido es de ${span} días)`
        : null;
};

/** Lanza 400 si el rango excede el máximo; para los exportes, que validan en el servicio. */
export const assertReportSpan = (
    from: string | undefined,
    to: string | undefined,
    maxDays: number,
    now = new Date(),
): void => {
    const message = reportSpanError(from, to, maxDays, now);
    if (message) {
        throw badRequest(message);
    }
};

/** Agrega al esquema de query la validación del tope de rango (`from`/`to`). */
export const withMaxSpan = <T extends z.ZodTypeAny & { _output: { from?: string; to?: string } }>(
    schema: T,
    kind: ReportSpanKind = 'detail',
) =>
    schema.superRefine((data: { from?: string; to?: string }, ctx) => {
        const message = reportSpanError(data.from, data.to, getMaxReportSpanDays(kind));
        if (message) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        }
    }) as z.ZodEffects<T, T['_output'], T['_input']>;
