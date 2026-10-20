import { FieldValue, Transaction } from 'firebase-admin/firestore';
import { db } from '../utils/firestore';
import { getZonedYmd } from '../utils/timezone';

/**
 * Agregado diario de ventas (`dailyStats/{ymd}`), en el día **local** de la
 * farmacia. Existe para que una serie larga (el año del tablero) cueste ~365
 * lecturas en vez de una por venta (~110k con 300 ventas al día).
 *
 * Se mantiene dentro de las transacciones que crean y anulan ventas, así que
 * nunca diverge de ellas por un fallo a medias. Solo cuenta ventas **no
 * anuladas**; las devoluciones no lo tocan (la serie del tablero tampoco las
 * resta). Importes en centavos enteros para que los incrementos no acumulen
 * error de coma flotante.
 */
export const DAILY_STATS_TIME_ZONE = 'America/Mexico_City';

export interface DailyStats {
    ymd: string;
    salesTotalCents: number;
    salesCount: number;
}

const collection = () => db().collection('dailyStats');

export const statsDayOf = (date: Date): string =>
    getZonedYmd(date.getTime(), DAILY_STATS_TIME_ZONE);

/**
 * Suma `delta` al día de la venta. Va **después** de las lecturas de la
 * transacción, como cualquier escritura. `merge` crea el documento del día en la
 * primera venta.
 */
export const applySaleDelta = (
    transaction: Transaction,
    sale: { createdAt: Date; totalCents: number },
    direction: 1 | -1,
): void => {
    const ymd = statsDayOf(sale.createdAt);
    transaction.set(
        collection().doc(ymd),
        {
            ymd,
            salesTotalCents: FieldValue.increment(direction * sale.totalCents),
            salesCount: FieldValue.increment(direction),
            updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
    );
};

/** Días en `[fromYmd, toYmd)`; los días sin ventas simplemente no existen. */
export const listDailyStats = async (fromYmd: string, toYmd: string): Promise<DailyStats[]> => {
    const snapshot = await collection()
        .where('ymd', '>=', fromYmd)
        .where('ymd', '<', toYmd)
        .get();
    return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            ymd: String(data.ymd),
            salesTotalCents: Number(data.salesTotalCents ?? 0),
            salesCount: Number(data.salesCount ?? 0),
        };
    });
};

/** Reemplaza el día completo; lo usa el backfill, que recalcula desde las ventas. */
export const setDay = async (stats: DailyStats): Promise<void> => {
    await collection().doc(stats.ymd).set({
        ...stats,
        updatedAt: FieldValue.serverTimestamp(),
    });
};
