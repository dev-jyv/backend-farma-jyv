import { dateFormatter, timeFormatter } from '../../module-reports.service';

type Stamp = { toDate(): Date };

export const stampDate = (value: Stamp): string => dateFormatter.format(value.toDate());
export const stampTime = (value: Stamp): string => timeFormatter.format(value.toDate());

/** `2026-10-13` (o un ISO completo) → `13/10/2026`; lo que no sea fecha pasa igual. */
export const ymdToDisplay = (value: string): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
};

/** Porcentaje con dos decimales; 0 si no hay base contra la que medirlo. */
export const percentOf = (part: number, whole: number): number =>
    whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0;

export const MAX_ROWS = 5000;
