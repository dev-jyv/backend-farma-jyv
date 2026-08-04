/**
 * Serialización CSV para exportaciones (libro de control, reportes).
 *
 * Dos cosas que no son obvias:
 *
 * 1. **Inyección de fórmulas.** Excel y Sheets evalúan una celda que empieza con
 *    `=`, `+`, `-`, `@`, tab o CR. Como el libro de control incluye texto que
 *    capturó el cajero (nombre del médico, cliente, motivo), un valor como
 *    `=HYPERLINK(...)` se ejecutaría al abrir el archivo. Se neutraliza con un
 *    apóstrofo al frente.
 * 2. **BOM.** Sin `﻿` al inicio, Excel en Windows abre el archivo como
 *    ANSI y los acentos salen rotos.
 */

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

const NEEDS_QUOTES = /[",\n\r]/;

export const escapeCsvValue = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }

    let text = String(value);

    if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
        text = `'${text}`;
    }

    if (NEEDS_QUOTES.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
};

export const buildCsvRow = (values: unknown[]): string =>
    values.map(escapeCsvValue).join(',');

/** Devuelve el CSV completo con BOM y CRLF (lo que espera Excel). */
export const buildCsv = (headers: string[], rows: unknown[][]): string => {
    const lines = [buildCsvRow(headers), ...rows.map(buildCsvRow)];
    return `﻿${lines.join('\r\n')}\r\n`;
};
