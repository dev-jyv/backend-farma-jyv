import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
    CLINIC_TIME_ZONE,
    DEFAULT_APPOINTMENT_MINUTES,
    MAX_CALENDAR_RANGE_DAYS,
    SLOT_GRID_MINUTES,
    WORKING_HOURS,
} from '../constants/clinic';
import {
    createAppointmentSchema,
    rescheduleAppointmentSchema,
    updateAppointmentSchema,
    updateAppointmentStatusSchema,
} from '../schemas';
import { Appointment, AppointmentStatus, ClinicActor } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import { db, now } from '../utils/firestore';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import {
    zonedDayRangeMs,
    zonedMinutesOfDay,
    zonedStartOfDayMs,
    zonedWeekday,
} from '../utils/timezone';
import * as appointmentsRepo from '../repositories/appointments.repository';
import * as patientsRepo from '../repositories/patients.repository';
import * as rolesRepo from '../repositories/roles.repository';
import * as usersRepo from '../repositories/users.repository';
import { recordAudit } from './audit.service';

type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
type RescheduleInput = z.infer<typeof rescheduleAppointmentSchema>;
type UpdateStatusInput = z.infer<typeof updateAppointmentStatusSchema>;
type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;

/**
 * De qué estados se puede pasar a cuál. La agenda es un flujo, no un campo
 * libre: reabrir una cita cancelada o "completar" una que nunca empezó deja la
 * ocupación del consultorio sin sentido y ensucia el reporte de asistencia.
 */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
    scheduled: ['confirmed', 'in_progress', 'cancelled', 'no_show'],
    confirmed: ['in_progress', 'cancelled', 'no_show'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
    no_show: [],
};

const FINAL_STATUSES: AppointmentStatus[] = ['completed', 'cancelled', 'no_show'];

const addMinutes = (timestamp: Timestamp, minutes: number): Timestamp =>
    Timestamp.fromMillis(timestamp.toMillis() + minutes * 60 * 1000);

/** Traslape de intervalos semiabiertos: dos citas pegadas (10:00–10:30 y 10:30–11:00) no chocan. */
const overlaps = (
    startA: number,
    endA: number,
    startB: number,
    endB: number,
): boolean => startA < endB && startB < endA;

/**
 * Ventana de citas que *podrían* traslaparse con `[startAt, endAt)`. Firestore
 * no admite dos desigualdades sobre campos distintos, así que se consulta por
 * `startAt` con 12 h de holgura a cada lado (la cita más larga permitida son 8 h)
 * y el traslape real se decide en memoria.
 */
const CLASH_WINDOW_MS = 12 * 3600 * 1000;

const buildClashWindowQuery = (
    doctorId: string,
    startAt: Timestamp,
    endAt: Timestamp,
): FirebaseFirestore.Query => appointmentsRepo.buildDoctorWindowQuery(
    doctorId,
    Timestamp.fromMillis(startAt.toMillis() - CLASH_WINDOW_MS),
    Timestamp.fromMillis(endAt.toMillis() + CLASH_WINDOW_MS),
);

const assertWithinWorkingHours = (startMs: number, durationMinutes: number): void => {
    const weekday = zonedWeekday(startMs, CLINIC_TIME_ZONE);
    const blocks = WORKING_HOURS[weekday] ?? [];
    if (blocks.length === 0) {
        throw badRequest('El consultorio no atiende ese día');
    }

    const startMinute = zonedMinutesOfDay(startMs, CLINIC_TIME_ZONE);
    const endMinute = startMinute + durationMinutes;
    const fits = blocks.some(
        (block) => startMinute >= block.startMinute && endMinute <= block.endMinute,
    );
    if (!fits) {
        throw badRequest('El horario está fuera del turno de atención del consultorio');
    }
};

const toClockTime = (minuteOfDay: number): string => {
    const hours = Math.floor(minuteOfDay / 60);
    const minutes = minuteOfDay % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

export interface ClinicSettings {
    timeZone: string;
    defaultDurationMinutes: number;
    slotGridMinutes: number;
    maxCalendarRangeDays: number;
    /** Un elemento por bloque de atención; `weekday` 0 = domingo. Los días cerrados no aparecen. */
    workingHours: Array<{ weekday: number; startTime: string; endTime: string }>;
}

/**
 * Parámetros de operación del consultorio para que el front pinte el calendario
 * con el mismo horario que valida el servidor, en vez de repetirlo a mano. Sale
 * de `constants/clinic.ts`; el día que el horario se vuelva configurable, solo
 * cambia esta función y el front no se entera.
 */
export const getClinicSettings = (): ClinicSettings => ({
    timeZone: CLINIC_TIME_ZONE,
    defaultDurationMinutes: DEFAULT_APPOINTMENT_MINUTES,
    slotGridMinutes: SLOT_GRID_MINUTES,
    maxCalendarRangeDays: MAX_CALENDAR_RANGE_DAYS,
    workingHours: WORKING_HOURS.flatMap((blocks, weekday) => blocks.map((block) => ({
        weekday,
        startTime: toClockTime(block.startMinute),
        endTime: toClockTime(block.endMinute),
    }))),
});

export const listAppointments = async (filters: {
    patientId?: string;
    doctorId?: string;
    status?: AppointmentStatus;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Appointment[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await appointmentsRepo.listAppointments({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getAppointment = async (id: string): Promise<Appointment> => {
    const appointment = await appointmentsRepo.getAppointmentById(id);
    if (!appointment) {
        throw notFound('Cita');
    }
    return appointment;
};

export const getCalendar = async (filters: {
    from: string;
    to: string;
    doctorId?: string;
}): Promise<Appointment[]> => {
    const spanDays = Math.round(
        (zonedStartOfDayMs(filters.to, CLINIC_TIME_ZONE) -
            zonedStartOfDayMs(filters.from, CLINIC_TIME_ZONE)) / (24 * 3600 * 1000),
    );
    if (spanDays < 0) {
        throw badRequest('La fecha inicial debe ser anterior a la final');
    }
    if (spanDays > MAX_CALENDAR_RANGE_DAYS) {
        throw badRequest(`El rango no puede exceder ${MAX_CALENDAR_RANGE_DAYS} días`);
    }
    return appointmentsRepo.listAppointmentsInRange(filters);
};

/**
 * Alta de cita. El choque de horarios se verifica **dentro** de la transacción
 * que crea el documento: dos recepcionistas apartando el mismo hueco al mismo
 * tiempo contienden sobre las mismas citas del día y una de las dos reintenta y
 * recibe el 409. Verificar antes de la transacción dejaría pasar el doble
 * agendado por la ventana entre la lectura y la escritura.
 */
export const createAppointment = async (
    input: CreateAppointmentInput,
    actor: ClinicActor,
): Promise<Appointment> => {
    const doctorId = input.doctorId ?? actor.userId;
    const durationMinutes = input.durationMinutes ?? DEFAULT_APPOINTMENT_MINUTES;

    const startAt = Timestamp.fromDate(new Date(input.startAt));
    const endAt = addMinutes(startAt, durationMinutes);

    if (startAt.toMillis() < Date.now()) {
        throw badRequest('No se puede agendar una cita en el pasado');
    }
    assertWithinWorkingHours(startAt.toMillis(), durationMinutes);

    const [patient, doctor] = await Promise.all([
        patientsRepo.getPatientById(input.patientId),
        usersRepo.getUserProfile(doctorId),
    ]);
    if (!patient) {
        throw notFound('Paciente');
    }
    if (!patient.isActive) {
        throw badRequest('El paciente está inactivo');
    }
    if (!doctor) {
        throw notFound('Doctor');
    }
    if (!doctor.isActive) {
        throw badRequest('El doctor está inactivo');
    }

    const firestore = db();
    const appointmentRef = appointmentsRepo.appointmentsCollection().doc();
    const timestamp = now();

    return firestore.runTransaction(async (transaction) => {
        const daySnapshot = await transaction.get(
            buildClashWindowQuery(doctorId, startAt, endAt),
        );

        const clash = daySnapshot.docs
            .map((doc) => appointmentsRepo.mapAppointment(doc.id, doc.data()))
            .filter((existing) => appointmentsRepo.BLOCKING_STATUSES.includes(existing.status))
            .find((existing) => overlaps(
                startAt.toMillis(),
                endAt.toMillis(),
                existing.startAt.toMillis(),
                existing.endAt.toMillis(),
            ));

        if (clash) {
            throw conflict('El doctor ya tiene una cita en ese horario');
        }

        const payload = {
            patientId: patient.id,
            patientName: patient.fullName,
            doctorId,
            doctorName: doctor.displayName,
            startAt,
            endAt,
            durationMinutes,
            reason: input.reason,
            status: 'scheduled' as AppointmentStatus,
            notes: input.notes,
            createdBy: actor.userId,
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        transaction.set(appointmentRef, payload);
        return { id: appointmentRef.id, ...payload };
    });
};

export const rescheduleAppointment = async (
    id: string,
    input: RescheduleInput,
    actor: ClinicActor,
): Promise<Appointment> => {
    const existing = await getAppointment(id);
    if (FINAL_STATUSES.includes(existing.status)) {
        throw badRequest('Una cita cerrada no se puede reagendar; crea una nueva');
    }

    const durationMinutes = input.durationMinutes ?? existing.durationMinutes;
    const startAt = Timestamp.fromDate(new Date(input.startAt));
    const endAt = addMinutes(startAt, durationMinutes);

    if (startAt.toMillis() < Date.now()) {
        throw badRequest('No se puede agendar una cita en el pasado');
    }
    assertWithinWorkingHours(startAt.toMillis(), durationMinutes);

    const firestore = db();
    const appointmentRef = appointmentsRepo.appointmentsCollection().doc(id);
    const timestamp = now();

    const updated = await firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(appointmentRef);
        if (!doc.exists) {
            throw notFound('Cita');
        }
        const current = appointmentsRepo.mapAppointment(doc.id, doc.data()!);

        const daySnapshot = await transaction.get(
            buildClashWindowQuery(current.doctorId, startAt, endAt),
        );

        const clash = daySnapshot.docs
            .filter((candidate) => candidate.id !== id)
            .map((candidate) => appointmentsRepo.mapAppointment(candidate.id, candidate.data()))
            .filter((other) => appointmentsRepo.BLOCKING_STATUSES.includes(other.status))
            .find((other) => overlaps(
                startAt.toMillis(),
                endAt.toMillis(),
                other.startAt.toMillis(),
                other.endAt.toMillis(),
            ));

        if (clash) {
            throw conflict('El doctor ya tiene una cita en ese horario');
        }

        transaction.update(appointmentRef, {
            startAt,
            endAt,
            durationMinutes,
            updatedAt: timestamp,
        });

        return { ...current, startAt, endAt, durationMinutes, updatedAt: timestamp };
    });

    await recordAudit({
        action: 'appointment.rescheduled',
        entity: 'appointment',
        entityId: id,
        summary: `Cita de ${existing.patientName} reagendada`,
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        changes: {
            startAt: {
                before: existing.startAt.toDate().toISOString(),
                after: startAt.toDate().toISOString(),
            },
        },
        metadata: input.reason ? { reason: input.reason } : null,
    });

    return updated;
};

export const changeAppointmentStatus = async (
    id: string,
    input: UpdateStatusInput,
    actor: ClinicActor,
): Promise<Appointment> => {
    const existing = await getAppointment(id);

    if (existing.status === input.status) {
        return existing;
    }
    if (!ALLOWED_TRANSITIONS[existing.status].includes(input.status)) {
        throw badRequest(
            `No se puede pasar una cita de "${existing.status}" a "${input.status}"`,
        );
    }

    const updated = await appointmentsRepo.updateAppointment(id, {
        status: input.status,
        cancelReason: input.status === 'cancelled' ? input.cancelReason : undefined,
    });

    if (input.status === 'cancelled') {
        await recordAudit({
            action: 'appointment.cancelled',
            entity: 'appointment',
            entityId: id,
            summary: `Cita de ${existing.patientName} cancelada`,
            userId: actor.userId,
            roleSlug: actor.roleSlug,
            changes: { status: { before: existing.status, after: input.status } },
            metadata: { cancelReason: input.cancelReason ?? null },
        });
    }

    return updated;
};

export const updateAppointment = async (
    id: string,
    input: UpdateAppointmentInput,
): Promise<Appointment> => {
    const existing = await getAppointment(id);
    if (FINAL_STATUSES.includes(existing.status)) {
        throw badRequest('Una cita cerrada no se puede editar');
    }
    return appointmentsRepo.updateAppointment(id, {
        reason: input.reason,
        notes: input.notes,
    });
};

export interface AvailabilitySlot {
    startAt: string;
    endAt: string;
}

/**
 * Huecos libres del día para un doctor: se recorre la rejilla de
 * `SLOT_GRID_MINUTES` dentro de los bloques de atención y se descarta lo que
 * choque con una cita vigente o ya haya pasado.
 */
export const getAvailability = async (filters: {
    date: string;
    doctorId: string;
    durationMinutes?: number;
}): Promise<{ date: string; doctorId: string; durationMinutes: number;
    slots: AvailabilitySlot[]; }> => {
    const durationMinutes = filters.durationMinutes ?? DEFAULT_APPOINTMENT_MINUTES;
    if (durationMinutes < 5 || durationMinutes > 480) {
        throw badRequest('La duración debe estar entre 5 y 480 minutos');
    }

    const { startMs } = zonedDayRangeMs(filters.date, CLINIC_TIME_ZONE);
    const weekday = zonedWeekday(startMs, CLINIC_TIME_ZONE);
    const blocks = WORKING_HOURS[weekday] ?? [];

    const booked = (await appointmentsRepo.listAppointmentsInRange({
        from: filters.date,
        to: filters.date,
        doctorId: filters.doctorId,
    })).filter((appointment) => appointmentsRepo.BLOCKING_STATUSES.includes(appointment.status));

    const nowMs = Date.now();
    const slots: AvailabilitySlot[] = [];

    for (const block of blocks) {
        for (
            let minute = block.startMinute;
            minute + durationMinutes <= block.endMinute;
            minute += SLOT_GRID_MINUTES
        ) {
            const slotStartMs = startMs + minute * 60 * 1000;
            const slotEndMs = slotStartMs + durationMinutes * 60 * 1000;

            if (slotStartMs < nowMs) {
                continue;
            }

            const taken = booked.some((appointment) => overlaps(
                slotStartMs,
                slotEndMs,
                appointment.startAt.toMillis(),
                appointment.endAt.toMillis(),
            ));
            if (taken) {
                continue;
            }

            slots.push({
                startAt: new Date(slotStartMs).toISOString(),
                endAt: new Date(slotEndMs).toISOString(),
            });
        }
    }

    return { date: filters.date, doctorId: filters.doctorId, durationMinutes, slots };
};

/**
 * Doctores activos para el selector de la agenda. Existe aparte de `GET /users`
 * porque ese endpoint exige `users:read` y un doctor no lo tiene: solo necesita
 * saber a nombre de quién puede agendar, no el padrón de personal completo.
 */
export const listDoctors = async (): Promise<Array<{ id: string; displayName: string }>> => {
    const doctorRole = await rolesRepo.getRoleBySlug('doctor');
    if (!doctorRole) {
        return [];
    }
    const { items } = await usersRepo.listUserProfiles({
        roleId: doctorRole.id,
        activeOnly: true,
        limit: 100,
    });
    return items.map((user) => ({ id: user.id, displayName: user.displayName }));
};
