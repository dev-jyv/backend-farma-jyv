import { Timestamp } from 'firebase-admin/firestore';

/**
 * Fechas de calendario (SPEC 18): `invoiceDate`, `dueDate`, `expiryDate`.
 *
 * Son un día, no un instante. Guardadas a la medianoche UTC (`new Date('2026-10-31')`)
 * en México (UTC-6) se leen como las 18:00 del día anterior, y el admin las pinta
 * un día antes. Se guardan al **mediodía UTC**: en cualquier zona entre UTC-12 y
 * UTC+11 el instante cae en el mismo día de calendario.
 *
 * Los documentos anteriores siguen a medianoche UTC hasta que corra
 * `npm run backfill:calendar-dates`; por eso las comparaciones por igualdad y por
 * rango tratan ambas representaciones (ver `calendarTimestampVariants` y
 * `toRangeStart`/`toRangeEnd`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON_MS = 12 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

const dayOf = (value: string): string => DAY_PREFIX.exec(value)?.[1] ?? value;

/** `YYYY-MM-DD` (o un ISO que empiece con él) a las 12:00 UTC de ese día. */
export const toCalendarTimestamp = (value: string): Timestamp =>
    Timestamp.fromDate(new Date(`${dayOf(value)}T12:00:00.000Z`));

/** Las dos formas en que puede estar guardada una fecha: medianoche (anterior) y mediodía. */
export const calendarTimestampVariants = (value: string): [Timestamp, Timestamp] => [
    Timestamp.fromDate(new Date(`${dayOf(value)}T00:00:00.000Z`)),
    toCalendarTimestamp(value),
];

/** Filtro `desde`: una fecha sola abarca desde el inicio de ese día; con hora, ese instante. */
export const toRangeStart = (value: string): Timestamp =>
    DATE_ONLY.test(value)
        ? Timestamp.fromDate(new Date(`${value}T00:00:00.000Z`))
        : Timestamp.fromDate(new Date(value));

/**
 * Filtro `hasta`: una fecha sola abarca hasta el final de ese día. Comparar contra
 * su medianoche dejaba fuera los documentos de ese mismo día guardados a mediodía.
 */
export const toRangeEnd = (value: string): Timestamp =>
    DATE_ONLY.test(value)
        ? Timestamp.fromDate(new Date(`${value}T23:59:59.999Z`))
        : Timestamp.fromDate(new Date(value));

/** Día de calendario (`YYYY-MM-DD`) de una fecha guardada, en cualquiera de las dos formas. */
export const calendarDayOf = (stamp: Timestamp): string =>
    stamp.toDate().toISOString().slice(0, 10);

/** ¿Está guardada con la representación anterior (medianoche UTC exacta)? */
export const isLegacyMidnight = (stamp: Timestamp): boolean =>
    stamp.toMillis() % DAY_MS === 0;

/** La misma fecha en la representación nueva. */
export const shiftToNoon = (stamp: Timestamp): Timestamp =>
    Timestamp.fromMillis(stamp.toMillis() + NOON_MS);
