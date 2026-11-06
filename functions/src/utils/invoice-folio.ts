/**
 * Folio de factura normalizado (SPEC 58). "A-123", "A123" y "a 0123" son la misma
 * factura escrita distinto: compararlos como texto dejaba registrar dos veces la
 * misma factura del mismo proveedor y, con ella, dos veces su mercancía.
 *
 * Mayúsculas, sin espacios ni guiones, y sin ceros a la izquierda en cada tramo
 * numérico ("A-0123" → "A123"; "000" → "0").
 */
export const normalizeInvoiceFolio = (invoiceNumber: string): string =>
    invoiceNumber
        .toUpperCase()
        .replace(/[\s-]+/g, '')
        .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ''));
