import { Injectable } from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';
import { db, now, toTimestamp } from '../utils/firestore';

@Injectable()
export class FirestoreService {
    db() {
        return db();
    }

    now(): Timestamp {
        return now();
    }

    toTimestamp(date: string): Timestamp {
        return toTimestamp(date);
    }
}
