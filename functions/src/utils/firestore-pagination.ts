/**
 * Página resuelta **en Firestore** en vez de en memoria.
 *
 * El patrón que reemplaza —leer la colección filtrada completa, ordenar en el
 * proceso y cortar la página con `paginate()`— cobra una lectura por documento
 * existente para devolver 20 filas, en cada carga de pantalla. Aquí solo se lee
 * hasta el final de la página pedida.
 *
 * Dos condiciones que hay que respetar al usarlo:
 *
 * 1. **La consulta ya viene ordenada.** El mismo objeto se usa para leer y para
 *    contar, así que `count()` cuenta exactamente lo que la paginación puede
 *    listar: si el `orderBy` descarta documentos sin ese campo, los descarta de
 *    los dos lados y `total` no miente.
 * 2. **El orden es el de Firestore (UTF-8)**, no `localeCompare`: los acentos
 *    se ordenan después de la Z. Es el precio de no leer todo, y es el orden
 *    que ya usa el índice.
 *
 * No sirve cuando hay un filtro posterior en memoria (búsqueda de texto): ahí
 * recortar antes de filtrar perdería coincidencias que están más allá de la
 * página.
 */
export const paginateQuery = async <T>(
    orderedQuery: FirebaseFirestore.Query,
    map: (doc: FirebaseFirestore.QueryDocumentSnapshot) => T,
    page: number,
    limit: number,
): Promise<{ items: T[]; total: number }> => {
    const upTo = page * limit;

    // `count()` se factura por entradas de índice recorridas, no por documento
    // leído: es lo que permite seguir devolviendo `total` sin traer la colección.
    const [snapshot, countSnapshot] = await Promise.all([
        orderedQuery.limit(upTo).get(),
        orderedQuery.count().get(),
    ]);

    return {
        items: snapshot.docs.slice(upTo - limit).map(map),
        total: countSnapshot.data().count,
    };
};
