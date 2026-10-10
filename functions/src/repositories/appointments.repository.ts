import { Timestamp } from 'firebase-admin/firestore';
import { Appointment } from '../types';
import { notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { db, now } from '../utils/firestore';

const collection = () => db().collection('appointments');

/** Estados que ya no ocupan lugar en la agenda: no bloquean el horario. */
export const BLOCKING_STATUSES: Appointment['status'][] = [
    'scheduled',
    'confirmed',
    'in_progress',
];

export const mapAppointment = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): Appointment => ({
    id,
    patientId: data.patientId as string,
    patientName: data.patientName as string,
    doctorId: data.doctorId as string,
    doctorName: data.doctorName as string,
    startAt: data.startAt as Timestamp,
    endAt: data.endAt as Timestamp,
    durationMinutes: data.durationMinutes as number,
    reason: data.reason as string | undefined,
    status: data.status as Appointment['status'],
    notes: data.notes as string | undefined,
    cancelReason: data.cancelReason as string | undefined,
    medicalRecordId: data.medicalRecordId as string | undefined,
    createdBy: data.createdBy as string,
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
});

export const listAppointments = async (filters: {
    patientId?: string;
    doctorId?: string;
    status?: Appointment['status'];
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Appointment[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;

    const snapshot = await buildRangeQuery(filters).orderBy('startAt', 'asc').get();
    let appointments = snapshot.docs.map((doc) => mapAppointment(doc.id, doc.data()));

    if (filters.status) {
        appointments = appointments.filter((item) => item.status === filters.status);
    }

    return paginate(appointments, page, limit);
};

const buildRangeQuery = (filters: {
    patientId?: string;
    doctorId?: string;
    from?: string;
    to?: string;
}): FirebaseFirestore.Query => {
    let query: FirebaseFirestore.Query = collection();
    if (filters.patientId) {
        query = query.where('patientId', '==', filters.patientId);
    }
    if (filters.doctorId) {
        query = query.where('doctorId', '==', filters.doctorId);
    }
    if (filters.from) {
        query = query.where('startAt', '>=', Timestamp.fromDate(
            new Date(`${filters.from}T00:00:00`),
        ));
    }
    if (filters.to) {
        query = query.where('startAt', '<=', Timestamp.fromDate(
            new Date(`${filters.to}T23:59:59.999`),
        ));
    }
    return query;
};

/** Lo que pinta el calendario: rango completo, sin paginar. */
export const listAppointmentsInRange = async (filters: {
    from: string;
    to: string;
    doctorId?: string;
}): Promise<Appointment[]> => {
    const snapshot = await buildRangeQuery(filters).orderBy('startAt', 'asc').get();
    return snapshot.docs.map((doc) => mapAppointment(doc.id, doc.data()));
};

export const getAppointmentById = async (id: string): Promise<Appointment | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapAppointment(doc.id, doc.data()!);
};

/**
 * Citas del doctor cuyo `startAt` cae en una ventana. Se usa dentro de la
 * transacción que agenda: el traslape exacto lo decide el servicio comparando
 * `startAt`/`endAt` en memoria, porque Firestore no admite dos desigualdades
 * sobre campos distintos.
 */
export const buildDoctorWindowQuery = (
    doctorId: string,
    windowStart: Timestamp,
    windowEnd: Timestamp,
): FirebaseFirestore.Query => collection()
    .where('doctorId', '==', doctorId)
    .where('startAt', '>=', windowStart)
    .where('startAt', '<=', windowEnd);

export const appointmentsCollection = collection;

type AppointmentWriteData = Omit<Appointment, 'id' | 'createdAt' | 'updatedAt'>;

export const updateAppointment = async (
    id: string,
    data: Partial<AppointmentWriteData>,
): Promise<Appointment> => {
    await collection().doc(id).update({ ...data, updatedAt: now() });
    const updated = await getAppointmentById(id);
    if (!updated) {
        throw notFound('Cita');
    }
    return updated;
};

export const countUpcomingByPatient = async (patientId: string): Promise<number> => {
    const snapshot = await collection()
        .where('patientId', '==', patientId)
        .where('startAt', '>=', now())
        .count()
        .get();
    return snapshot.data().count;
};
