/**
 * Regla única de identidad de producto entre cajas (SPEC 60).
 *
 * Dos cajas sin red pueden dar de alta el mismo producto. El servidor compara el
 * nombre **normalizado** (`nameKey`) y, ante un choque, solo se adopta el
 * producto existente si es el mismo: el código de barras coincide cuando los dos
 * lo tienen, o el `nameKey` coincide cuando alguno no lo tiene.
 *
 * Copia **a propósito** de `shared/utils/product-match.ts` del POS, igual que
 * `taxes.ts` y `promotions.ts`: si cambia la normalización en un lado, cambia en
 * los dos, o la caja y el servidor dejan de reconocer el mismo producto.
 */

/** Lo que la regla necesita de un producto, local o remoto. */
export interface MatchableProduct {
    name: string;
    concentration?: string | null;
    barcode?: string | null;
}

/**
 * Nombre comparable: nombre + concentración, sin acentos, en minúsculas, con
 * espacios colapsados y sin el espacio entre una cifra y su unidad, para que
 * "Paracetamol 500 mg" y "paracetamol  500MG" sean el mismo.
 */
export const productNameKey = (
    name: string | null | undefined,
    concentration?: string | null,
): string => `${name ?? ''} ${concentration ?? ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d) (?=[a-zµ%])/g, '$1');

const cleanBarcode = (barcode: string | null | undefined): string =>
    String(barcode ?? '').trim();

/** ¿El remoto es el mismo producto que el local? Ver la regla arriba. */
export const isSameProduct = (local: MatchableProduct, remote: MatchableProduct): boolean => {
    const localBarcode = cleanBarcode(local.barcode);
    const remoteBarcode = cleanBarcode(remote.barcode);
    if (localBarcode && remoteBarcode) {
        return localBarcode === remoteBarcode;
    }
    const localKey = productNameKey(local.name, local.concentration);
    return localKey !== '' && localKey === productNameKey(remote.name, remote.concentration);
};
