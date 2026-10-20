import * as fs from 'fs';
import * as path from 'path';

interface IndexField {
    fieldPath: string;
    order?: string;
    arrayConfig?: string;
}
interface CompositeIndex {
    collectionGroup: string;
    fields: IndexField[];
}

const indexes: CompositeIndex[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.indexes.json'), 'utf8'),
).indexes;

const has = (
    collection: string,
    ...fields: Array<[string, 'CONTAINS' | 'ASCENDING' | 'DESCENDING']>
): boolean => indexes.some((index) =>
    index.collectionGroup === collection &&
    index.fields.length === fields.length &&
    fields.every(([fieldPath, kind], position) => {
        const field = index.fields[position];
        return field.fieldPath === fieldPath &&
            (kind === 'CONTAINS' ? field.arrayConfig === 'CONTAINS' : field.order === kind);
    }));

/**
 * El emulador de Firestore no exige índices compuestos: una consulta sin índice
 * pasa todas las pruebas y en producción responde 500 (FAILED_PRECONDITION).
 * `GET /products/:id/sales-history` lo sufrió: pide `productIds array-contains` con
 * `createdAt` descendente y solo existía el ascendente. Firestore necesita un índice
 * por dirección, así que cada consulta con `array-contains` + orden descendente
 * tiene que estar declarada aquí.
 */
describe('índices compuestos declarados para consultas con array-contains', () => {
    it('ventas por producto, más recientes primero (historial y listado por cursor)', () => {
        expect(has('sales', ['productIds', 'CONTAINS'], ['createdAt', 'DESCENDING'])).toBe(true);
    });

    it('ventas por producto en orden ascendente (analítica por ventana)', () => {
        expect(has('sales', ['productIds', 'CONTAINS'], ['createdAt', 'ASCENDING'])).toBe(true);
    });

    it('entradas de inventario por producto, más recientes primero', () => {
        expect(
            has('inventoryEntries', ['productIds', 'CONTAINS'], ['createdAt', 'DESCENDING']),
        ).toBe(true);
    });
});
