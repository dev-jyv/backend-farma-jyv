import { z } from 'zod';
import { isoDate, paginationFields, parseableDate, phoneMx } from './common';

const nullable = <T extends z.ZodTypeAny>(schema: T) =>
    schema.nullish().transform((value): z.infer<T> | undefined => value ?? undefined);

const text = (max: number) => z.string().trim().min(1).max(max);

/** CURP: 18 caracteres con la estructura oficial de RENAPO. */
export const curp = z
    .string()
    .trim()
    .toUpperCase()
    .regex(
        /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d$/,
        'CURP inválida',
    );

export const patientSexSchema = z.enum(['male', 'female', 'other']);

export const bloodTypeSchema = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);

export const emergencyContactSchema = z.object({
    name: text(120),
    phone: phoneMx,
    relationship: nullable(text(60)),
});

/**
 * La fecha de nacimiento no puede ser futura y se topa a 130 años: un typo de
 * año (1092 en vez de 1992) desordena todo el cálculo de edad del expediente.
 */
const birthDate = isoDate.refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    const todayMs = Date.now();
    const maxAgeMs = 130 * 365.25 * 24 * 60 * 60 * 1000;
    return date.getTime() <= todayMs && todayMs - date.getTime() <= maxAgeMs;
}, { message: 'La fecha de nacimiento no es válida' });

const tagList = (max: number) => z.array(text(80)).max(max);

export const createPatientSchema = z.object({
    firstName: text(80),
    lastName: text(80),
    birthDate,
    sex: patientSexSchema,
    phone: nullable(phoneMx),
    email: nullable(z.string().trim().email()),
    curp: nullable(curp),
    bloodType: nullable(bloodTypeSchema),
    allergies: tagList(30).optional(),
    chronicConditions: tagList(30).optional(),
    customerId: nullable(z.string().min(1)),
    address: nullable(text(250)),
    emergencyContact: nullable(emergencyContactSchema),
    notes: nullable(z.string().trim().max(2000)),
});

export const updatePatientSchema = createPatientSchema.partial().extend({
    isActive: nullable(z.boolean()),
});

export const listPatientsQuerySchema = z.object({
    ...paginationFields,
    includeInactive: nullable(z.enum(['true', 'false'])),
});

/* ── Expediente clínico ────────────────────────────────────────────────── */

export const medicalRecordTypeSchema = z.enum([
    'consultation',
    'followUp',
    'labResult',
    'imaging',
    'prescription',
    'note',
]);

/**
 * Rangos fisiológicos amplios a propósito: rechazan el dedo pegado en el
 * teclado (una temperatura de 370 °C) sin discutir el criterio clínico.
 */
export const vitalsSchema = z.object({
    heightCm: nullable(z.number().finite().min(20).max(260)),
    weightKg: nullable(z.number().finite().min(0.5).max(400)),
    temperatureC: nullable(z.number().finite().min(25).max(45)),
    systolic: nullable(z.number().int().min(40).max(300)),
    diastolic: nullable(z.number().int().min(20).max(200)),
    heartRate: nullable(z.number().int().min(20).max(250)),
    respiratoryRate: nullable(z.number().int().min(4).max(80)),
    oxygenSaturation: nullable(z.number().int().min(40).max(100)),
}).refine(
    (value) => value.systolic === undefined ||
        value.diastolic === undefined ||
        value.systolic > value.diastolic,
    { message: 'La presión sistólica debe ser mayor que la diastólica' },
);

export const createMedicalRecordSchema = z.object({
    patientId: z.string().min(1),
    type: medicalRecordTypeSchema,
    /** Por defecto, el momento de la captura. */
    visitedAt: nullable(parseableDate),
    appointmentId: nullable(z.string().min(1)),
    chiefComplaint: nullable(z.string().trim().max(500)),
    vitals: nullable(vitalsSchema),
    diagnosis: nullable(z.string().trim().max(1000)),
    treatment: nullable(z.string().trim().max(2000)),
    notes: nullable(z.string().trim().max(5000)),
    /**
     * Archivos ya subidos vía `POST /v1/uploads`. Se validan contra Storage
     * antes de guardarse, para que el expediente no apunte a rutas inventadas.
     */
    attachments: z.array(z.object({
        storagePath: z.string().min(1),
        fileName: nullable(text(200)),
    })).max(20).optional(),
});

/** El paciente y el autor de la nota no se pueden reasignar: eso es un expediente nuevo. */
export const updateMedicalRecordSchema = createMedicalRecordSchema
    .omit({ patientId: true, attachments: true })
    .partial();

export const listMedicalRecordsQuerySchema = z.object({
    ...paginationFields,
    patientId: nullable(z.string().min(1)),
    doctorId: nullable(z.string().min(1)),
    type: nullable(medicalRecordTypeSchema),
    from: nullable(isoDate),
    to: nullable(isoDate),
});

/* ── Agenda de citas ───────────────────────────────────────────────────── */

export const appointmentStatusSchema = z.enum([
    'scheduled',
    'confirmed',
    'in_progress',
    'completed',
    'cancelled',
    'no_show',
]);

export const createAppointmentSchema = z.object({
    patientId: z.string().min(1),
    /** Si se omite, la cita queda a nombre del usuario que la crea. */
    doctorId: nullable(z.string().min(1)),
    startAt: parseableDate,
    durationMinutes: z.number().int().min(5).max(480),
    reason: nullable(z.string().trim().max(500)),
    notes: nullable(z.string().trim().max(2000)),
});

export const rescheduleAppointmentSchema = z.object({
    startAt: parseableDate,
    durationMinutes: nullable(z.number().int().min(5).max(480)),
    reason: nullable(z.string().trim().max(500)),
});

export const updateAppointmentStatusSchema = z.object({
    status: appointmentStatusSchema,
    /** Obligatorio al cancelar: una cancelación sin motivo no sirve al reporte. */
    cancelReason: nullable(z.string().trim().max(500)),
}).refine(
    (value) => value.status !== 'cancelled' || Boolean(value.cancelReason),
    { message: 'El motivo de cancelación es requerido' },
);

export const updateAppointmentSchema = z.object({
    reason: nullable(z.string().trim().max(500)),
    notes: nullable(z.string().trim().max(2000)),
});

export const listAppointmentsQuerySchema = z.object({
    ...paginationFields,
    patientId: nullable(z.string().min(1)),
    doctorId: nullable(z.string().min(1)),
    status: nullable(appointmentStatusSchema),
    from: nullable(isoDate),
    to: nullable(isoDate),
});

/** Rango que pinta el calendario: se exige explícito para no barrer la agenda entera. */
export const appointmentsCalendarQuerySchema = z.object({
    from: isoDate,
    to: isoDate,
    doctorId: nullable(z.string().min(1)),
});

export const attachmentParamsSchema = z.object({
    id: z.string().min(1),
    attachmentId: z.string().min(1),
});

export const availabilityQuerySchema = z.object({
    date: isoDate,
    doctorId: nullable(z.string().min(1)),
    durationMinutes: nullable(z.string()),
});
