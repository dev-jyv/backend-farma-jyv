/**
 * Parámetros de operación del consultorio. Viven aquí (y no en Firestore) porque
 * hoy hay un solo consultorio con horario fijo; si se vuelven configurables por
 * doctor, mover a una colección `clinicSettings` y leerlos desde el servicio.
 */

export const CLINIC_TIME_ZONE = 'America/Mexico_City';

/** Bloque de atención en minutos desde la medianoche local. */
export interface WorkingBlock {
    startMinute: number;
    endMinute: number;
}

const morning: WorkingBlock = { startMinute: 9 * 60, endMinute: 14 * 60 };
const afternoon: WorkingBlock = { startMinute: 16 * 60, endMinute: 20 * 60 };

/** Índice = día de la semana local (0 = domingo). Domingo cerrado. */
export const WORKING_HOURS: WorkingBlock[][] = [
    [],
    [morning, afternoon],
    [morning, afternoon],
    [morning, afternoon],
    [morning, afternoon],
    [morning, afternoon],
    [{ startMinute: 9 * 60, endMinute: 13 * 60 }],
];

/** Duración por defecto de una consulta. */
export const DEFAULT_APPOINTMENT_MINUTES = 30;

/** Rejilla en la que se ofrecen los huecos libres. */
export const SLOT_GRID_MINUTES = 15;

/** Tope de días que puede pedir el calendario en una sola llamada. */
export const MAX_CALENDAR_RANGE_DAYS = 92;
