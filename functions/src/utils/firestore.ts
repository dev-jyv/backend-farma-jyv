import { getFirestore, Timestamp } from 'firebase-admin/firestore';

export const db = () => getFirestore();

export const now = (): Timestamp => Timestamp.now();

export const toTimestamp = (date: string): Timestamp =>
    Timestamp.fromDate(new Date(date));
