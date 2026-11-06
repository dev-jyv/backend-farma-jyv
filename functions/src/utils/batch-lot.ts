import { createHash } from 'crypto';

/**
 * Identidad de un lote al recibir mercancía (SPEC 59).
 *
 * El mismo lote llega escrito de varias formas ("abc 12", "ABC12"): la factura,
 * la foto y el cajero no coinciden en mayúsculas ni espacios. Comparar el texto
 * tal cual partía un lote en dos, cada uno con su propia caducidad y costo.
 */

/** Número de lote en mayúsculas y sin espacios: la llave con la que se compara. */
export const normalizeLotKey = (lotNumber: string): string =>
    lotNumber.replace(/\s+/g, '').toUpperCase();

/**
 * Id determinista del lote: `productId` + `lotKey` + caducidad (`YYYY-MM-DD`).
 * Dos entradas simultáneas del mismo lote nuevo escriben el **mismo** documento,
 * así que la transacción de la segunda choca con la primera y suma en vez de
 * crear otro lote. Los lotes anteriores tienen id aleatorio y se encuentran por
 * consulta.
 */
export const deterministicBatchId = (
    productId: string,
    lotKey: string,
    expiryYmd: string,
): string => createHash('sha256')
    .update(`${productId}\u0000${lotKey}\u0000${expiryYmd}`)
    .digest('hex')
    .slice(0, 40);

/**
 * Costo por pieza al sumar a un lote existente: promedio ponderado por las piezas
 * que quedan y las que entran, a 4 decimales. Si uno de los dos no tiene costo se
 * queda el que exista: un costo ausente no es un costo cero.
 */
export const weightedBatchCost = (
    previousQuantity: number,
    previousCost: number | null | undefined,
    addedQuantity: number,
    addedCost: number | null | undefined,
): number | undefined => {
    const hasPrevious = typeof previousCost === 'number' && Number.isFinite(previousCost);
    const hasAdded = typeof addedCost === 'number' && Number.isFinite(addedCost);
    if (!hasAdded) {
        return hasPrevious ? previousCost : undefined;
    }
    if (!hasPrevious) {
        return addedCost;
    }
    // Un lote agotado (o con un descuadre negativo) no pondera: su costo ya no
    // describe ninguna pieza en el anaquel.
    const remaining = Math.max(previousQuantity, 0);
    const total = remaining + addedQuantity;
    if (total <= 0) {
        return addedCost;
    }
    const weighted = (remaining * previousCost + addedQuantity * addedCost) / total;
    return Math.round(weighted * 10_000) / 10_000;
};
