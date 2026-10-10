import { Timestamp } from 'firebase-admin/firestore';
import { Patient } from '../types';
import { conflict, notFound } from '../utils/errors';
import { paginate } from '../utils/pagination';
import { paginateQuery } from '../utils/firestore-pagination';
import { db, now } from '../utils/firestore';

const PATIENTS_COUNTER_ID = 'patients';

const collection = () => db().collection('patients');

const buildFolio = (sequence: number): string => `EXP-${String(sequence).padStart(6, '0')}`;

export const mapPatient = (
    id: string,
    data: FirebaseFirestore.DocumentData,
): Patient => ({
    id,
    folio: data.folio as string,
    firstName: data.firstName as string,
    lastName: data.lastName as string,
    fullName: data.fullName as string,
    birthDate: data.birthDate as Timestamp,
    sex: data.sex as Patient['sex'],
    phone: data.phone as string | undefined,
    email: data.email as string | undefined,
    curp: data.curp as string | undefined,
    bloodType: data.bloodType as Patient['bloodType'],
    allergies: (data.allergies as string[] | undefined) ?? [],
    chronicConditions: (data.chronicConditions as string[] | undefined) ?? [],
    customerId: data.customerId as string | undefined,
    address: data.address as string | undefined,
    emergencyContact: data.emergencyContact as Patient['emergencyContact'],
    notes: data.notes as string | undefined,
    isActive: (data.isActive as boolean | undefined) ?? true,
    createdAt: data.createdAt as Timestamp,
    updatedAt: data.updatedAt as Timestamp,
});

/**
 * El padrón de un consultorio es chico y la búsqueda es por nombre parcial,
 * folio, teléfono o CURP: se filtra en memoria como el catálogo de productos,
 * porque Firestore no hace `contains` sobre texto.
 */
const matchesSearch = (patient: Patient, term: string): boolean => {
    const haystack = [
        patient.fullName,
        patient.folio,
        patient.phone,
        patient.email,
        patient.curp,
    ]
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
    return haystack.includes(term);
};

export const listPatients = async (filters: {
    search?: string;
    includeInactive?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: Patient[]; total: number }> => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;

    // El padrón se ordena por nombre completo. Sin búsqueda la página la
    // resuelve Firestore (índice `[isActive, fullName]` cuando se excluye a los
    // inactivos, que es el caso por defecto); la búsqueda por nombre/CURP/
    // teléfono sigue en memoria porque Firestore no hace coincidencia parcial.
    if (!filters.search) {
        const query = filters.includeInactive
            ? collection()
            : collection().where('isActive', '==', true);
        return paginateQuery(
            query.orderBy('fullName', 'asc'),
            (doc) => mapPatient(doc.id, doc.data()),
            page,
            limit,
        );
    }

    const snapshot = await collection().orderBy('fullName', 'asc').get();
    let patients = snapshot.docs.map((doc) => mapPatient(doc.id, doc.data()));

    if (!filters.includeInactive) {
        patients = patients.filter((patient) => patient.isActive);
    }

    const term = filters.search.trim().toLowerCase();
    patients = patients.filter((patient) => matchesSearch(patient, term));

    return paginate(patients, page, limit);
};

export const getPatientById = async (id: string): Promise<Patient | null> => {
    const doc = await collection().doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapPatient(doc.id, doc.data()!);
};

type PatientWriteData = Omit<Patient, 'id' | 'folio' | 'fullName' | 'createdAt' | 'updatedAt'>;

/**
 * Folio y unicidad de CURP se resuelven **dentro** de la misma transacción que
 * la escritura, igual que la unicidad de SKU en productos: dos altas simultáneas
 * del mismo paciente comparten el mismo documento contador y una de las dos
 * reintenta, en vez de crear dos expedientes con el mismo folio o la misma CURP.
 */
export const createPatient = async (data: PatientWriteData): Promise<Patient> => {
    const firestore = db();
    const patientRef = collection().doc();
    const counterRef = firestore.collection('counters').doc(PATIENTS_COUNTER_ID);
    const timestamp = now();

    return firestore.runTransaction(async (transaction) => {
        const counterDoc = await transaction.get(counterRef);

        if (data.curp) {
            const duplicated = await transaction.get(
                collection().where('curp', '==', data.curp).limit(1),
            );
            if (!duplicated.empty) {
                throw conflict('Ya existe un paciente con esa CURP');
            }
        }

        const nextSequence = ((counterDoc.data()?.value as number | undefined) ?? 0) + 1;
        const payload = {
            ...data,
            folio: buildFolio(nextSequence),
            fullName: `${data.firstName} ${data.lastName}`,
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        transaction.set(counterRef, { value: nextSequence }, { merge: true });
        transaction.set(patientRef, payload);

        return { id: patientRef.id, ...payload };
    });
};

export const updatePatient = async (
    id: string,
    data: Partial<PatientWriteData>,
): Promise<Patient> => {
    const firestore = db();
    const patientRef = collection().doc(id);
    const timestamp = now();

    await firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(patientRef);
        if (!doc.exists) {
            throw notFound('Paciente');
        }

        if (data.curp) {
            const duplicated = await transaction.get(
                collection().where('curp', '==', data.curp).limit(1),
            );
            const clash = duplicated.docs.find((candidate) => candidate.id !== id);
            if (clash) {
                throw conflict('Ya existe un paciente con esa CURP');
            }
        }

        const current = mapPatient(doc.id, doc.data()!);
        const firstName = data.firstName ?? current.firstName;
        const lastName = data.lastName ?? current.lastName;

        transaction.update(patientRef, {
            ...data,
            fullName: `${firstName} ${lastName}`,
            updatedAt: timestamp,
        });
    });

    const updated = await getPatientById(id);
    if (!updated) {
        throw notFound('Paciente');
    }
    return updated;
};
