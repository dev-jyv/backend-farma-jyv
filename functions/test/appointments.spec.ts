import { Timestamp } from 'firebase-admin/firestore';
import * as patientsRepo from '../src/repositories/patients.repository';
import * as usersRepo from '../src/repositories/users.repository';
import * as appointmentsService from '../src/services/appointments.service';
import { ClinicActor } from '../src/types';
import { CLINIC_TIME_ZONE } from '../src/constants/clinic';

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const actor: ClinicActor = {
    userId: 'test-doctor',
    displayName: 'Dra. Prueba',
    roleSlug: 'doctor',
};

/**
 * Fecha futura garantizada dentro del turno (lunes a viernes, 10:00 hora de
 * México). Se busca el próximo lunes para que la prueba no dependa del día en
 * que corra ni caiga en domingo (consultorio cerrado).
 */
const nextMondayAt = (hour: number, minute = 0): string => {
    const weekdayIn = (date: Date) => new Intl.DateTimeFormat('en-US', {
        timeZone: CLINIC_TIME_ZONE,
        weekday: 'short',
    }).format(date);

    let candidate = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    for (let offset = 0; offset < 7 && weekdayIn(candidate) !== 'Mon'; offset += 1) {
        candidate = new Date(candidate.getTime() + 24 * 3600 * 1000);
    }

    const ymd = new Intl.DateTimeFormat('en-CA', {
        timeZone: CLINIC_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(candidate);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    // Offset fijo de México (sin horario de verano desde 2022).
    return `${ymd}T${hh}:${mm}:00.000-06:00`;
};

const createPatientFixture = async () => {
    const [firstName, lastName] = [unique('Paciente'), unique('Apellido')];
    return patientsRepo.createPatient({
        firstName,
        lastName,
        birthDate: Timestamp.fromDate(new Date('1990-05-10T12:00:00Z')),
        sex: 'female',
        allergies: [],
        chronicConditions: [],
        isActive: true,
    });
};

const createDoctorFixture = async () => {
    const uid = unique('doctor');
    await usersRepo.createUserProfile(uid, {
        email: `${uid}@example.com`,
        displayName: 'Dr. Fixture',
        roleId: 'role-doctor',
        isActive: true,
    });
    return uid;
};

describe('appointments.service - agenda', () => {
    it('agenda una cita y rechaza el traslape del mismo doctor', async () => {
        const [patient, doctorId] = await Promise.all([
            createPatientFixture(),
            createDoctorFixture(),
        ]);
        const startAt = nextMondayAt(10);

        const created = await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt,
            durationMinutes: 30,
        }, actor);

        expect(created.status).toBe('scheduled');
        expect(created.patientName).toBe(patient.fullName);
        expect(created.endAt.toMillis() - created.startAt.toMillis()).toBe(30 * 60 * 1000);

        await expect(appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt: nextMondayAt(10, 15),
            durationMinutes: 30,
        }, actor)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('permite citas pegadas: 10:00-10:30 y 10:30-11:00 no chocan', async () => {
        const [patient, doctorId] = await Promise.all([
            createPatientFixture(),
            createDoctorFixture(),
        ]);

        await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt: nextMondayAt(10),
            durationMinutes: 30,
        }, actor);

        const second = await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt: nextMondayAt(10, 30),
            durationMinutes: 30,
        }, actor);

        expect(second.id).toBeDefined();
    });

    it('cancelar libera el horario', async () => {
        const [patient, doctorId] = await Promise.all([
            createPatientFixture(),
            createDoctorFixture(),
        ]);
        const startAt = nextMondayAt(11);

        const first = await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt,
            durationMinutes: 30,
        }, actor);

        await appointmentsService.changeAppointmentStatus(first.id, {
            status: 'cancelled',
            cancelReason: 'El paciente avisó que no podrá asistir',
        }, actor);

        const replacement = await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt,
            durationMinutes: 30,
        }, actor);

        expect(replacement.id).not.toBe(first.id);
    });

    it('rechaza horarios fuera del turno de atención', async () => {
        const [patient, doctorId] = await Promise.all([
            createPatientFixture(),
            createDoctorFixture(),
        ]);

        await expect(appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt: nextMondayAt(6),
            durationMinutes: 30,
        }, actor)).rejects.toMatchObject({ statusCode: 400 });

        // 13:45 + 30 min se sale del bloque matutino (termina 14:00).
        await expect(appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt: nextMondayAt(13, 45),
            durationMinutes: 30,
        }, actor)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rechaza transiciones de estado imposibles', async () => {
        const [patient, doctorId] = await Promise.all([
            createPatientFixture(),
            createDoctorFixture(),
        ]);

        const appointment = await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt: nextMondayAt(12),
            durationMinutes: 30,
        }, actor);

        // scheduled -> completed no existe: la consulta debe pasar por in_progress.
        await expect(appointmentsService.changeAppointmentStatus(appointment.id, {
            status: 'completed',
        }, actor)).rejects.toMatchObject({ statusCode: 400 });

        await appointmentsService.changeAppointmentStatus(appointment.id, {
            status: 'in_progress',
        }, actor);
        const completed = await appointmentsService.changeAppointmentStatus(appointment.id, {
            status: 'completed',
        }, actor);

        expect(completed.status).toBe('completed');
    });

    it('los huecos libres excluyen lo ya agendado', async () => {
        const [patient, doctorId] = await Promise.all([
            createPatientFixture(),
            createDoctorFixture(),
        ]);
        const startAt = nextMondayAt(9);
        const date = startAt.slice(0, 10);

        await appointmentsService.createAppointment({
            patientId: patient.id,
            doctorId,
            startAt,
            durationMinutes: 60,
        }, actor);

        const availability = await appointmentsService.getAvailability({
            date,
            doctorId,
            durationMinutes: 30,
        });

        const occupied = availability.slots.filter((slot) => {
            const slotStart = new Date(slot.startAt).getTime();
            return slotStart >= new Date(startAt).getTime() &&
                slotStart < new Date(startAt).getTime() + 60 * 60 * 1000;
        });

        expect(occupied).toHaveLength(0);
        expect(availability.slots.length).toBeGreaterThan(0);
    });
});
