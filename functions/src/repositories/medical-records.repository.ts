import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { MedicalRecord, MedicalRecordAttachment } from '../types';
import { notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('medicalRecords');

export const mapMedicalRecord = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): MedicalRecord => ({
    id,
    patientId: data.patientId as string,
    patientName: data.patientName as string,
    doctorId: data.doctorId as string,
    doctorName: data.doctorName as string,
    appointmentId: data.appointmentId as string | undefined,
    type: data.type as MedicalRecord['type'],
    visitedAt: data.visitedAt as Timestamp,
    chiefComplaint: data.chiefComplaint as string | undefined,
    vitals: data.vitals as MedicalRecord['vitals'],
    diagnosis: data.diagnosis as string | undefined,
    treatment: data.treatment as string | undefined,
    notes: data.notes as string | undefined,
    attachments: (data.attachments as MedicalRecordAttachment[] | undefined) ?? [],
    createdBy: data.createdBy as string,
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
});

/**
 * Se consulta por paciente (el caso normal: abrir su expediente) o por rango de
 * fechas, siempre ordenado por fecha de atención descendente. El filtrado
 * restante y la paginación quedan en el servicio, como en el resto de la API.
 */
export const listMedicalRecords = async (filters: {
    patientId?: string;
    doctorId?: string;
    type?: MedicalRecord['type'];
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: MedicalRecord[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;

    let query: FirebaseFirestore.Query = collection();
    if (filters.patientId) {
        query = query.where('patientId', '==', filters.patientId);
    }
    if (filters.doctorId) {
        query = query.where('doctorId', '==', filters.doctorId);
    }
    if (filters.from) {
        query = query.where('visitedAt', '>=', Timestamp.fromDate(
            new Date(`${filters.from}T00:00:00`),
        ));
    }
    if (filters.to) {
        query = query.where('visitedAt', '<=', Timestamp.fromDate(
            new Date(`${filters.to}T23:59:59.999`),
        ));
    }

    const snapshot = await query.orderBy('visitedAt', 'desc').get();
    let records = snapshot.docs.map((doc) => mapMedicalRecord(doc.id, doc.data()));

    if (filters.type) {
        records = records.filter((record) => record.type === filters.type);
    }

    return paginate(records, page, limit);
};

export const getMedicalRecordById = async (id: string): Promise<MedicalRecord | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapMedicalRecord(doc.id, doc.data()!);
};

export const countRecordsByPatient = async (patientId: string): Promise<number> => {
    const snapshot = await collection().where('patientId', '==', patientId).count().get();
    return snapshot.data().count;
};

type MedicalRecordWriteData = Omit<MedicalRecord, 'id' | 'createdAt' | 'updatedAt'>;

export const createMedicalRecord = async (
    data: MedicalRecordWriteData,
): Promise<MedicalRecord> => {
    const timestamp = now();
    const payload = { ...data, createdAt: timestamp, updatedAt: timestamp };
    const ref = await collection().add(payload);
    return { id: ref.id, ...payload };
};

export const updateMedicalRecord = async (
    id: string,
    data: Partial<Omit<MedicalRecordWriteData, 'patientId' | 'patientName' | 'attachments'>>,
): Promise<MedicalRecord> => {
    await collection().doc(id).update({ ...data, updatedAt: now() });
    const updated = await getMedicalRecordById(id);
    if (!updated) {
        throw notFound('Nota del expediente');
    }
    return updated;
};

/**
 * `arrayUnion` en vez de leer-modificar-escribir: dos archivos subidos en
 * paralelo a la misma nota no se pisan.
 */
export const addAttachment = async (
    id: string,
    attachment: MedicalRecordAttachment,
): Promise<MedicalRecord> => {
    await collection().doc(id).update({
        attachments: FieldValue.arrayUnion(attachment),
        updatedAt: now(),
    });
    const updated = await getMedicalRecordById(id);
    if (!updated) {
        throw notFound('Nota del expediente');
    }
    return updated;
};

export const removeAttachment = async (
    id: string,
    attachment: MedicalRecordAttachment,
): Promise<MedicalRecord> => {
    await collection().doc(id).update({
        attachments: FieldValue.arrayRemove(attachment),
        updatedAt: now(),
    });
    const updated = await getMedicalRecordById(id);
    if (!updated) {
        throw notFound('Nota del expediente');
    }
    return updated;
};
