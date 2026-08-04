/**
 * Impuestos al consumo en México aplicables a una farmacia.
 *
 * Los precios del catálogo (`product.salePrice`) son **precio al público con
 * impuestos incluidos**: lo que dice la etiqueta es lo que se cobra. El desglose
 * se calcula hacia atrás (ver `utils/taxes.ts`), nunca sumando encima del precio.
 */

/** Tasa general de IVA. */
export const IVA_RATE = 0.16;

/** Tasa 0% (medicinas de patente y alimentos, art. 2-A LIVA). */
export const IVA_ZERO_RATE = 0;

/**
 * El IEPS varía por producto (8% alimentos de alta densidad calórica, 26.5%
 * bebidas saborizadas, 30%+ tabaco), así que la tasa vive en el producto
 * (`product.iepsRate`) y no hay un valor por defecto: un producto marcado con
 * `hasIeps` y sin tasa es un error de captura, no un 0 silencioso.
 */
export const MAX_IEPS_RATE = 1.6;
