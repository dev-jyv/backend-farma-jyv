import { getFirestore, Timestamp } from 'firebase-admin/firestore';

let settingsApplied = false;

// Muchos servicios construyen payloads con campos opcionales en `undefined`
// (ej. barcode, costPrice). El SDK de Admin rechaza esos valores por defecto;
// se habilita una vez, en el único punto de entrada a Firestore de la app.
export const db = () => {
    const firestore = getFirestore();
    if (!settingsApplied) {
        firestore.settings({ ignoreUndefinedProperties: true });
        settingsApplied = true;
    }
    return firestore;
};

export const now = (): Timestamp => Timestamp.now();

export const toTimestamp = (date: string): Timestamp =>
    Timestamp.fromDate(new Date(date));
