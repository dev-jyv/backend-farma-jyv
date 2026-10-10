import { db, now } from '../utils/firestore';
import { conflict } from '../utils/errors';

const COLLECTION = 'pointOrders';
const TTL_HOURS = 48;

const ownerRef = (orderId: string) => db().collection(COLLECTION).doc(orderId);

export const recordPointOrderOwner = async (
    orderId: string,
    cashierId: string,
): Promise<void> => {
    const timestamp = now();
    try {
        await ownerRef(orderId).create({
            cashierId,
            createdAt: timestamp,
            expiresAt: new Date(timestamp.toMillis() + TTL_HOURS * 60 * 60 * 1000),
        });
    } catch (error) {
        if ((error as { code?: number }).code !== 6) {
            throw error;
        }
        const existing = await getPointOrderOwner(orderId);
        if (existing !== cashierId) {
            throw conflict('Esta orden ya está asociada a otro cajero');
        }
    }
};

export const getPointOrderOwner = async (orderId: string): Promise<string | null> => {
    const snapshot = await ownerRef(orderId).get();
    const cashierId = snapshot.data()?.cashierId;
    return typeof cashierId === 'string' ? cashierId : null;
};
