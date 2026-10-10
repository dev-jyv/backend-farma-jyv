import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { createPatientSchema, updatePatientSchema } from '../schemas';
import { Patient } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import * as patientsRepo from '../repositories/patients.repository';
import * as recordsRepo from '../repositories/medical-records.repository';
import * as appointmentsRepo from '../repositories/appointments.repository';

type CreatePatientInput = z.infer<typeof createPatientSchema>;
type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

/** Edad en años cumplidos; la calcula el servidor para que no dependa del reloj del cliente. */
export const calculateAge = (birthDate: Timestamp, nowMs = Date.now()): number => {
    const birth = birthDate.toDate();
    const today = new Date(nowMs);
    let age = today.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - birth.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birth.getUTCDate())) {
        age -= 1;
    }
    return age;
};

export interface PatientWithAge extends Patient {
    age: number;
}

const withAge = (patient: Patient): PatientWithAge => ({
    ...patient,
    age: calculateAge(patient.birthDate),
});

export const listPatients = async (filters: {
    search?: string;
    includeInactive?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: PatientWithAge[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await patientsRepo.listPatients({ ...filters, page, limit });
    return { items: items.map(withAge), meta: buildListMeta(page, limit, total) };
};

export const getPatient = async (id: string): Promise<PatientWithAge> => {
    const patient = await patientsRepo.getPatientById(id);
    if (!patient) {
        throw notFound('Paciente');
    }
    return withAge(patient);
};

/** Encabezado del expediente: datos del paciente + conteos para la vista de detalle. */
export const getPatientOverview = async (id: string): Promise<{
    patient: PatientWithAge;
    recordCount: number;
    upcomingAppointments: number;
    lastVisitAt: Timestamp | null;
}> => {
    const patient = await getPatient(id);
    const [recordCount, upcomingAppointments, lastRecords] = await Promise.all([
        recordsRepo.countRecordsByPatient(id),
        appointmentsRepo.countUpcomingByPatient(id),
        recordsRepo.listMedicalRecords({ patientId: id, page: 1, limit: 1 }),
    ]);

    return {
        patient,
        recordCount,
        upcomingAppointments,
        lastVisitAt: lastRecords.items[0]?.visitedAt ?? null,
    };
};

const toTimestampFromIsoDate = (isoDate: string): Timestamp =>
    Timestamp.fromDate(new Date(`${isoDate}T12:00:00Z`));

export const createPatient = async (input: CreatePatientInput): Promise<PatientWithAge> => {
    const patient = await patientsRepo.createPatient({
        firstName: input.firstName,
        lastName: input.lastName,
        // Mediodía UTC: guarda la fecha civil sin que un cambio de zona la mueva
        // un día hacia atrás al formatearla en México.
        birthDate: toTimestampFromIsoDate(input.birthDate),
        sex: input.sex,
        phone: input.phone,
        email: input.email?.toLowerCase(),
        curp: input.curp,
        bloodType: input.bloodType,
        allergies: input.allergies ?? [],
        chronicConditions: input.chronicConditions ?? [],
        customerId: input.customerId,
        address: input.address,
        emergencyContact: input.emergencyContact,
        notes: input.notes,
        isActive: true,
    });
    return withAge(patient);
};

/**
 * El paciente no se borra: el expediente clínico debe conservarse (NOM-004 pide
 * 5 años como mínimo). Darlo de baja del padrón es este mismo `update` con
 * `isActive: false`, y por eso no existe una operación de borrado.
 */
export const updatePatient = async (
    id: string,
    input: UpdatePatientInput,
): Promise<PatientWithAge> => {
    const existing = await patientsRepo.getPatientById(id);
    if (!existing) {
        throw notFound('Paciente');
    }

    if (Object.keys(input).length === 0) {
        throw badRequest('No hay cambios que aplicar');
    }

    const patient = await patientsRepo.updatePatient(id, {
        firstName: input.firstName,
        lastName: input.lastName,
        birthDate: input.birthDate ? toTimestampFromIsoDate(input.birthDate) : undefined,
        sex: input.sex,
        phone: input.phone,
        email: input.email?.toLowerCase(),
        curp: input.curp,
        bloodType: input.bloodType,
        allergies: input.allergies,
        chronicConditions: input.chronicConditions,
        customerId: input.customerId,
        address: input.address,
        emergencyContact: input.emergencyContact,
        notes: input.notes,
        isActive: input.isActive,
    });
    return withAge(patient);
};
