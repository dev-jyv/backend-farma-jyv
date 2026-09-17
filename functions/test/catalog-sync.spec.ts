import * as categoriesRepo from '../src/repositories/categories.repository';
import * as suppliersRepo from '../src/repositories/suppliers.repository';
import * as categoriesService from '../src/services/categories.service';
import * as suppliersService from '../src/services/suppliers.service';

/**
 * `GET /categories/sync` y `/suppliers/sync` existen por costo: traer el
 * catálogo completo por el endpoint paginado cobraba `N × (P+1) / 2` lecturas,
 * porque el backend resuelve la página N leyendo `N × limit` documentos y
 * descartando las anteriores.
 *
 * Lo que se fija aquí es lo que hace correcto al atajo:
 *  - devuelve **todo**, sin el tope de 100 de la paginación;
 *  - con `updatedSince` devuelve solo lo tocado desde el corte;
 *  - y en ese delta **sí** viajan las bajas, porque el cliente las necesita
 *    para sacarlas de su copia. Si se filtraran por `isActive`, un registro
 *    desactivado desaparecería del delta y viviría para siempre en el cliente.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Corte anclado al propio documento. Tomarlo con `Date.now()` y escribir a
 * continuación es una carrera: si ambas cosas caen en el mismo milisegundo, el
 * `>=` de la consulta deja fuera el cambio que la prueba acaba de hacer.
 */
const cortePara = (doc: { updatedAt: FirebaseFirestore.Timestamp }): string =>
    doc.updatedAt.toDate().toISOString();

const crearCategorias = async (cuantas: number, etiqueta: string) => {
    const ids: string[] = [];
    for (let i = 0; i < cuantas; i += 1) {
        const creada = await categoriesRepo.createCategory({
            name: `${etiqueta}-${String(i).padStart(3, '0')}`,
            isActive: true,
        });
        ids.push(creada.id);
    }
    return ids;
};

describe('listCategoriesForSync', () => {
    it('devuelve el catálogo completo por encima del tope de paginación', async () => {
        const etiqueta = unique('Cat');
        await crearCategorias(12, etiqueta);

        const { items } = await categoriesService.listCategoriesForSync({});
        const propias = items.filter((c) => c.name.startsWith(etiqueta));

        expect(propias).toHaveLength(12);
    });

    it('con updatedSince solo trae lo modificado desde el corte', async () => {
        const etiqueta = unique('Cat');
        const [primera] = await crearCategorias(3, etiqueta);

        const renombrada = await categoriesRepo.updateCategory(primera, {
            name: `${etiqueta}-renombrada`,
        });
        const corte = cortePara(renombrada);

        const { items } = await categoriesService.listCategoriesForSync({
            updatedSince: corte,
        });
        const tocadas = items.filter((c) => c.name.startsWith(etiqueta));

        // Solo la que se tocó: las otras dos siguen con su `updatedAt` de alta.
        expect(tocadas).toHaveLength(1);
        expect(tocadas[0].id).toBe(primera);
    });

    it('incluye las bajas en el delta para que el cliente pueda quitarlas', async () => {
        const etiqueta = unique('Cat');
        const [id] = await crearCategorias(1, etiqueta);

        const dadaDeBaja = await categoriesRepo.updateCategory(id, { isActive: false });

        const { items } = await categoriesService.listCategoriesForSync({
            updatedSince: cortePara(dadaDeBaja),
        });
        const baja = items.find((c) => c.id === id);

        // Si el sync filtrara por `isActive`, esto sería `undefined` y la
        // categoría se quedaría viva en el cliente para siempre.
        expect(baja).toBeDefined();
        expect(baja!.isActive).toBe(false);
    });
});

describe('listSuppliersForSync', () => {
    it('devuelve el catálogo completo, activos y dados de baja', async () => {
        const etiqueta = unique('Prov');
        const activo = await suppliersRepo.createSupplier({
            name: `${etiqueta}-activo`,
            isActive: true,
        });
        const inactivo = await suppliersRepo.createSupplier({
            name: `${etiqueta}-inactivo`,
            isActive: false,
        });

        const { items } = await suppliersService.listSuppliersForSync({});
        const ids = items.map((s) => s.id);

        expect(ids).toContain(activo.id);
        expect(ids).toContain(inactivo.id);
    });
});
