/**
 * Parser de códigos GS1-128 / GS1 DataMatrix.
 *
 * La caja de medicamento trae en el código lo que hoy se teclea a mano: GTIN,
 * lote y caducidad. El formato es una cadena de pares AI + valor, donde los AI de
 * longitud fija se leen por posición y los de longitud variable terminan en el
 * separador FNC1 (`GS`, 0x1D) o al final de la cadena.
 *
 * Ejemplo real: `]d201075012345678902110ABC123\x1D17270630`
 *   - `]d2`     símbolo DataMatrix (se descarta)
 *   - `01` + 14 GTIN
 *   - `10` + var lote (termina en FNC1)
 *   - `17` + 6  caducidad YYMMDD
 */

/** Separador FNC1 tal como lo emiten los lectores (0x1D) o escapado. */
const FNC1 = String.fromCharCode(29);

/** Identificadores de aplicación de longitud fija que nos interesan. */
const FIXED_LENGTH_AIS: Record<string, number> = {
    '00': 18, // SSCC
    '01': 14, // GTIN
    '02': 14, // GTIN de contenido
    11: 6, // fecha de producción
    12: 6, // fecha de vencimiento de pago
    13: 6, // fecha de envasado
    15: 6, // consumo preferente
    16: 6, // fecha de venta
    17: 6, // caducidad
    20: 2, // variante de producto
};

/** AI de longitud variable relevantes (terminan en FNC1). */
const VARIABLE_LENGTH_AIS = new Set(['10', '21', '30', '37', '240', '400', '410', '414']);

const MAX_VARIABLE_LENGTH = 30;

export interface Gs1ParseResult {
    /** AI encontrados, en crudo, por si hace falta algo que no mapeamos. */
    elements: Record<string, string>;
    gtin: string | null;
    /** GTIN normalizado a 13 dígitos (EAN-13), que es lo que guarda el catálogo. */
    barcode: string | null;
    lotNumber: string | null;
    /** Caducidad en `YYYY-MM-DD`. */
    expiryDate: string | null;
    productionDate: string | null;
    serial: string | null;
    quantity: number | null;
}

/** Prefijos de símbolo que agregan algunos lectores. */
const stripSymbologyIdentifier = (value: string): string =>
    value.replace(/^\](?:d2|C1|e0|Q3|d1)/i, '');

/**
 * `YYMMDD` → `YYYY-MM-DD`. GS1 usa ventana de 50 años centrada en el año actual;
 * `DD = 00` significa "fin de mes", que es común en caducidades de medicamento.
 */
export const parseGs1Date = (value: string, reference = new Date()): string | null => {
    if (!/^\d{6}$/.test(value)) {
        return null;
    }

    const yy = Number(value.slice(0, 2));
    const month = Number(value.slice(2, 4));
    const day = Number(value.slice(4, 6));

    if (month < 1 || month > 12 || day > 31) {
        return null;
    }

    const currentYear = reference.getFullYear();
    const century = Math.floor(currentYear / 100) * 100;
    let year = century + yy;
    // Ventana GS1: más de 50 años adelante = siglo anterior, y viceversa.
    if (year - currentYear > 50) {
        year -= 100;
    } else if (currentYear - year > 50) {
        year += 100;
    }

    // Día 00 = último día del mes.
    const resolvedDay = day === 0 ? new Date(year, month, 0).getDate() : day;
    const lastDayOfMonth = new Date(year, month, 0).getDate();
    if (resolvedDay > lastDayOfMonth) {
        return null;
    }

    const pad = (input: number) => String(input).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(resolvedDay)}`;
};

/**
 * GTIN-14 → EAN-13: el catálogo guarda 8-14 dígitos, pero los códigos impresos en
 * la caja suelen ser GTIN-14 con un cero de indicador al frente.
 */
export const gtinToBarcode = (gtin: string): string => {
    const trimmed = gtin.replace(/^0+/, '');
    return trimmed.length >= 8 ? trimmed : gtin.slice(-13).replace(/^0+/, '') || gtin;
};

/** ¿La cadena parece GS1 y no un EAN-13 pelón? */
export const looksLikeGs1 = (value: string): boolean => {
    const cleaned = stripSymbologyIdentifier(value.trim());
    if (cleaned.includes(FNC1) || /\(\d{2,4}\)/.test(cleaned)) {
        return true;
    }
    // `01` + 14 dígitos y sobra contenido: es GS1, no un código de barras simple.
    return /^01\d{14}.+/.test(cleaned);
};

/**
 * Parsea la cadena escaneada. Acepta tres formas: con FNC1 real, con AI entre
 * paréntesis (`(01)07501234567890(17)270630`) tal como la imprimen algunos
 * proveedores, o concatenada sin separadores cuando los AI son de longitud fija.
 */
export const parseGs1 = (raw: string): Gs1ParseResult => {
    const elements: Record<string, string> = {};
    const input = stripSymbologyIdentifier(raw.trim());

    if (/\(\d{2,4}\)/.test(input)) {
        const matches = input.matchAll(/\((\d{2,4})\)([^(]*)/g);
        for (const match of matches) {
            elements[match[1]] = match[2].trim();
        }
    } else {
        let cursor = 0;
        while (cursor < input.length) {
            if (input[cursor] === FNC1) {
                cursor += 1;
                continue;
            }

            // Los AI que usamos son de 2 dígitos; 3-4 dígitos solo en variables largas.
            const ai2 = input.slice(cursor, cursor + 2);
            const ai3 = input.slice(cursor, cursor + 3);
            const ai = VARIABLE_LENGTH_AIS.has(ai3) && !FIXED_LENGTH_AIS[ai2] ? ai3 : ai2;
            if (!/^\d+$/.test(ai)) {
                break;
            }
            cursor += ai.length;

            const fixedLength = FIXED_LENGTH_AIS[ai];
            if (fixedLength) {
                elements[ai] = input.slice(cursor, cursor + fixedLength);
                cursor += fixedLength;
                continue;
            }

            const separatorIndex = input.indexOf(FNC1, cursor);
            const end = separatorIndex === -1
                ? Math.min(input.length, cursor + MAX_VARIABLE_LENGTH)
                : separatorIndex;
            elements[ai] = input.slice(cursor, end);
            cursor = end;
        }
    }

    const gtin = elements['01'] || elements['02'] || null;
    const expiryRaw = elements['17'] ?? null;
    const productionRaw = elements['11'] ?? elements['13'] ?? null;
    const quantityRaw = elements['30'] ?? null;

    return {
        elements,
        gtin,
        barcode: gtin ? gtinToBarcode(gtin) : null,
        lotNumber: elements['10']?.trim() || null,
        expiryDate: expiryRaw ? parseGs1Date(expiryRaw) : null,
        productionDate: productionRaw ? parseGs1Date(productionRaw) : null,
        serial: elements['21']?.trim() || null,
        quantity: quantityRaw && /^\d+$/.test(quantityRaw) ? Number(quantityRaw) : null,
    };
};
