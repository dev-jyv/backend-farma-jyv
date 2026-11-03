import { toCents } from './taxes';

/**
 * Venta por caja completa (SPEC 46). Reglas de la configuración de caja de un
 * producto, compartidas por el esquema (forma del request) y por el repositorio
 * (estado final del documento, dentro de la transacción de la escritura).
 */

export const MIN_BOX_QUANTITY = 2;
export const MAX_BOX_QUANTITY = 1000;

export interface BoxConfig {
    salePrice: number;
    sku?: string;
    barcode?: string;
    boxQuantity?: number | null;
    boxPrice?: number | null;
    boxBarcode?: string | null;
}

/**
 * ¿La caja quedó más cara que sus piezas sueltas? Pasa cuando solo baja
 * `salePrice` (el POS edita precios sin red): esa edición no se rechaza, se
 * acepta y se deja en la bitácora para revisión.
 */
export const boxPriceExceedsPieces = (config: BoxConfig): boolean =>
    config.boxQuantity !== undefined && config.boxQuantity !== null &&
    config.boxPrice !== undefined && config.boxPrice !== null &&
    toCents(config.boxPrice) > toCents(config.salePrice) * config.boxQuantity;

/**
 * Por qué la configuración de caja no es válida, o `null`.
 *
 * - `boxQuantity` y `boxPrice` van juntos: una caja sin precio no se puede
 *   cobrar y un precio sin piezas no sabe cuánto stock bajar.
 * - `boxPrice ≤ boxQuantity × salePrice`: la caja nunca cuesta más que sus
 *   piezas sueltas. Se compara en centavos para no fallar por un residuo.
 * - `boxBarcode` solo con caja configurada y distinto del código y SKU propios:
 *   al escanearlo la caja tiene que saber que es una caja y no una pieza.
 */
export const boxConfigProblem = (
    config: BoxConfig,
    options: { checkPrice?: boolean } = {},
): string | null => {
    const hasQuantity = config.boxQuantity !== undefined && config.boxQuantity !== null;
    const hasPrice = config.boxPrice !== undefined && config.boxPrice !== null;
    if (hasQuantity !== hasPrice) {
        return 'Las piezas por caja y el precio de caja van juntos';
    }
    if (!hasQuantity) {
        return config.boxBarcode
            ? 'El código de barras de caja requiere configurar la venta por caja'
            : null;
    }
    const quantity = config.boxQuantity as number;
    const boxPrice = config.boxPrice as number;
    if (!Number.isInteger(quantity) || quantity < MIN_BOX_QUANTITY ||
        quantity > MAX_BOX_QUANTITY) {
        return `Las piezas por caja deben ser un entero de ${MIN_BOX_QUANTITY} a ` +
            `${MAX_BOX_QUANTITY}`;
    }
    if (!(boxPrice > 0)) {
        return 'El precio de caja debe ser mayor a cero';
    }
    if (options.checkPrice !== false && boxPriceExceedsPieces(config)) {
        return `El precio de caja ($${boxPrice.toFixed(2)}) no puede ser mayor que ` +
            `${quantity} piezas sueltas ($${(toCents(config.salePrice) * quantity / 100)
                .toFixed(2)})`;
    }
    if (config.boxBarcode &&
        (config.boxBarcode === config.barcode || config.boxBarcode === config.sku)) {
        return 'El código de barras de caja debe ser distinto del código de barras y del ' +
            'SKU del producto';
    }
    return null;
};
