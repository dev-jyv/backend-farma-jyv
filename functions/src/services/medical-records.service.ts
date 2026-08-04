import { randomUUID } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
    ALLOWED_UPLOAD_MIME_MESSAGE,
    ALLOWED_UPLOAD_MIME_TYPES,
} from '../constants/uploads';
import { createMedicalRecordSchema, updateMedicalRecordSchema } from '../schemas';
import { ClinicActor, MedicalRecord, MedicalRecordAttachment, Vitals } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { now } from '../utils/firestore';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import {
    assertFileExists,
    getFileMetadata,
    getFileUrl,
    sanitizeFileName,
    uploadFile,
} from '../utils/storage';
import * as recordsRepo from '../repositories/medical-records.repository';
import * as patientsRepo from '../repositories/patients.repository';
import * as appointmentsRepo from '../repositories/appointments.repository';
import { diffFields, recordAudit } from './audit.service';

type CreateMedicalRecordInput = z.infer<typeof createMedicalRecordSchema>;
type UpdateMedicalRecordInput = z.infer<typeof updateMedicalRecordSchema>;

/** Campos clínicos vigilados por la bitácora. */
const AUDITED_FIELDS: Array<keyof MedicalRecord> = [
    'type',
    'chiefComplaint',
    'diagnosis',
    'treatment',
    'notes',
    'visitedAt',
];

/**
 * IMC calculado en el servidor a partir de peso y talla: el cliente no lo manda,
 * así que dos pantallas distintas no pueden guardar dos IMC distintos para los
 * mismos números.
 */
const withBmi = (vitals: Vitals | undefined): Vitals | undefined => {
    if (!vitals) {
        return undefined;
    }
    const { heightCm, weightKg } = vitals;
    if (!heightCm || !weightKg) {
        return vitals;
    }
    const heightM = heightCm / 100;
    return { ...vitals, bmi: Math.round((weightKg / (heightM * heightM)) * 10) / 10 };
};

export const listMedicalRecords = async (filters: {
    patientId?: string;
    doctorId?: string;
    type?: MedicalRecord['type'];
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: MedicalRecord[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await recordsRepo.listMedicalRecords({ ...filters, page, limit });
    return { items, meta: buildListMeta(page, limit, total) };
};

export const getMedicalRecord = async (id: string): Promise<MedicalRecord> => {
    const record = await recordsRepo.getMedicalRecordById(id);
    if (!record) {
        throw notFound('Nota del expediente');
    }
    return record;
};

/**
 * Los adjuntos llegan como rutas de Storage ya subidas (`POST /v1/uploads`). Se
 * confirma contra Storage que el archivo existe antes de guardarlo: si no, el
 * expediente queda apuntando a una ruta inventada por el cliente y el enlace
 * revienta al abrirlo meses después.
 */
const resolveAttachments = async (
    attachments: CreateMedicalRecordInput['attachments'],
    userId: string,
): Promise<MedicalRecordAttachment[]> => {
    if (!attachments?.length) {
        return [];
    }

    const timestamp = now();
    return Promise.all(attachments.map(async (attachment) => {
        await assertFileExists(attachment.storagePath);
        const metadata = await getFileMetadata(attachment.storagePath);
        if (!ALLOWED_UPLOAD_MIME_TYPES.has(metadata.mimeType)) {
            throw badRequest(ALLOWED_UPLOAD_MIME_MESSAGE);
        }
        return {
            id: randomUUID(),
            storagePath: attachment.storagePath,
            fileName: attachment.fileName ?? metadata.fileName,
            mimeType: metadata.mimeType,
            sizeBytes: 0,
            uploadedBy: userId,
            uploadedAt: timestamp,
        };
    }));
};

export const createMedicalRecord = async (
    input: CreateMedicalRecordInput,
    actor: ClinicActor,
): Promise<MedicalRecord> => {
    const patient = await patientsRepo.getPatientById(input.patientId);
    if (!patient) {
        throw notFound('Paciente');
    }

    if (input.appointmentId) {
        const appointment = await appointmentsRepo.getAppointmentById(input.appointmentId);
        if (!appointment) {
            throw notFound('Cita');
        }
        if (appointment.patientId !== patient.id) {
            throw badRequest('La cita pertenece a otro paciente');
        }
    }

    const visitedAt = input.visitedAt
        ? Timestamp.fromDate(new Date(input.visitedAt))
        : now();
    if (visitedAt.toMillis() > Date.now() + 60 * 1000) {
        throw badRequest('La fecha de atención no puede ser futura');
    }

    const record = await recordsRepo.createMedicalRecord({
        patientId: patient.id,
        patientName: patient.fullName,
        doctorId: actor.userId,
        doctorName: actor.displayName,
        appointmentId: input.appointmentId,
        type: input.type,
        visitedAt,
        chiefComplaint: input.chiefComplaint,
        vitals: withBmi(input.vitals),
        diagnosis: input.diagnosis,
        treatment: input.treatment,
        notes: input.notes,
        attachments: await resolveAttachments(input.attachments, actor.userId),
        createdBy: actor.userId,
    });

    // La cita queda enlazada a su nota, para abrir una desde la otra.
    if (input.appointmentId) {
        await appointmentsRepo.updateAppointment(input.appointmentId, {
            medicalRecordId: record.id,
        });
    }

    return record;
};

/**
 * Editar una nota ya guardada **siempre** deja bitácora (`medicalRecord.updated`):
 * la NOM-004 pide que el expediente sea rastreable, y a diferencia del resto del
 * sistema aquí sí se auditan los cambios de contenido, no solo el dinero.
 */
export const updateMedicalRecord = async (
    id: string,
    input: UpdateMedicalRecordInput,
    actor: ClinicActor,
): Promise<MedicalRecord> => {
    const existing = await getMedicalRecord(id);

    if (Object.keys(input).length === 0) {
        throw badRequest('No hay cambios que aplicar');
    }

    const visitedAt = input.visitedAt
        ? Timestamp.fromDate(new Date(input.visitedAt))
        : undefined;
    if (visitedAt && visitedAt.toMillis() > Date.now() + 60 * 1000) {
        throw badRequest('La fecha de atención no puede ser futura');
    }

    const updated = await recordsRepo.updateMedicalRecord(id, {
        type: input.type,
        visitedAt,
        appointmentId: input.appointmentId,
        chiefComplaint: input.chiefComplaint,
        vitals: withBmi(input.vitals),
        diagnosis: input.diagnosis,
        treatment: input.treatment,
        notes: input.notes,
    });

    const changes = diffFields(
        existing as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
        AUDITED_FIELDS as unknown as Array<keyof Record<string, unknown>>,
    );

    await recordAudit({
        action: 'medicalRecord.updated',
        entity: 'medicalRecord',
        entityId: id,
        summary: `Nota clínica de ${existing.patientName} editada`,
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        changes,
        metadata: { patientId: existing.patientId },
    });

    return updated;
};

/**
 * Sube un archivo directo a la nota. Se guarda bajo
 * `clinical/<patientId>/<recordId>/` — nunca en `uploads/` — porque las reglas de
 * Storage deniegan todo acceso de cliente a ese prefijo y el archivo solo se sirve
 * mediante la URL firmada que devuelve la API.
 */
export const addAttachment = async (
    id: string,
    file: Express.Multer.File,
    actor: ClinicActor,
): Promise<MedicalRecord> => {
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
        throw badRequest(ALLOWED_UPLOAD_MIME_MESSAGE);
    }

    const record = await getMedicalRecord(id);
    const attachmentId = randomUUID();
    const fileName = sanitizeFileName(file.originalname);
    const storagePath = `clinical/${record.patientId}/${record.id}/${attachmentId}-${fileName}`;

    await uploadFile(storagePath, file.buffer, file.mimetype);

    const updated = await recordsRepo.addAttachment(id, {
        id: attachmentId,
        storagePath,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedBy: actor.userId,
        uploadedAt: now(),
    });

    await recordAudit({
        action: 'medicalRecord.attachment_added',
        entity: 'medicalRecord',
        entityId: id,
        summary: `Archivo "${file.originalname}" agregado al expediente de ${record.patientName}`,
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        metadata: { patientId: record.patientId, storagePath },
    });

    return updated;
};

/**
 * URL de descarga de un adjunto, resuelta bajo demanda. No se guarda en el
 * documento: listar el expediente no debería pegarle a Storage una vez por
 * archivo, y una URL persistida es un enlace público que sobrevive al permiso.
 */
export const getAttachmentUrl = async (
    id: string,
    attachmentId: string,
): Promise<{ fileName: string; mimeType: string; fileUrl: string }> => {
    const record = await getMedicalRecord(id);
    const attachment = record.attachments.find((item) => item.id === attachmentId);
    if (!attachment) {
        throw notFound('Archivo del expediente');
    }

    return {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileUrl: await getFileUrl(attachment.storagePath),
    };
};

export const removeAttachment = async (
    id: string,
    attachmentId: string,
    actor: ClinicActor,
): Promise<MedicalRecord> => {
    const record = await getMedicalRecord(id);
    const attachment = record.attachments.find((item) => item.id === attachmentId);
    if (!attachment) {
        throw notFound('Archivo del expediente');
    }

    const updated = await recordsRepo.removeAttachment(id, attachment);

    await recordAudit({
        action: 'medicalRecord.updated',
        entity: 'medicalRecord',
        entityId: id,
        summary: `Archivo "${attachment.fileName}" retirado del expediente ` +
            `de ${record.patientName}`,
        userId: actor.userId,
        roleSlug: actor.roleSlug,
        metadata: { patientId: record.patientId, storagePath: attachment.storagePath },
    });

    return updated;
};

/** Línea de tiempo del paciente: sus notas más recientes primero. */
export const getPatientTimeline = async (
    patientId: string,
    filters: { page?: number; limit?: number } = {},
): Promise<{ items: MedicalRecord[]; meta: ListMeta }> => {
    const patient = await patientsRepo.getPatientById(patientId);
    if (!patient) {
        throw notFound('Paciente');
    }
    return listMedicalRecords({ patientId, ...filters });
};
