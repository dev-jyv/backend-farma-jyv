/**
 * Búsqueda por prefijo del nombre en colecciones por persona (clientes,
 * pacientes, usuarios, roles).
 *
 * Cada documento guarda `searchName`: el nombre en minúsculas, sin acentos y
 * con espacios colapsados. La búsqueda es un rango sobre ese campo
 * (`>= term` y `<= term + ''`) con `limit`, así que cuesta como máximo
 * los documentos que se devuelven y no el tamaño de la colección.
 *
 * Solo prefijo del nombre completo: no hay coincidencia en medio del texto.
 */
export const SEARCH_NAME_FIELD = 'searchName';

// Mayor punto de código que Firestore usa como cota superior de un prefijo.
const PREFIX_UPPER_BOUND = '';

export const normalizeSearchName = (value: string): string =>
    value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

/**
 * Aplica el rango de prefijo y el orden por `searchName` a una consulta.
 * El término se usa como texto literal (no hay comodines en un rango).
 * Devuelve `null` si el término queda vacío tras normalizar: el llamador debe
 * usar entonces el listado normal.
 */
export const applyNamePrefix = (
    query: FirebaseFirestore.Query,
    search: string | undefined,
): FirebaseFirestore.Query | null => {
    const term = normalizeSearchName(search ?? '');
    if (!term) {
        return null;
    }
    return query
        .where(SEARCH_NAME_FIELD, '>=', term)
        .where(SEARCH_NAME_FIELD, '<=', term + PREFIX_UPPER_BOUND)
        .orderBy(SEARCH_NAME_FIELD, 'asc');
};
