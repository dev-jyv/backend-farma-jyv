import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../src/utils/firestore';
import * as categoriesRepo from '../src/repositories/categories.repository';
import * as productsRepo from '../src/repositories/products.repository';
import * as patientsRepo from '../src/repositories/patients.repository';
import * as inventoryService from '../src/services/inventory.service';
import * as patientsService from '../src/services/patients.service';

/**
 * SPEC 11: los listados históricos leen una ventana de 30 días por defecto, el
 * enriquecimiento (categoría) ocurre solo sobre la página, y la última visita
 * del paciente cuesta una lectura.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;
const daysAgo = (days: number) => Timestamp.fromMillis(Date.now() - days * 86_400_000);

const crearProducto = async (name: string) => {
    const category = await categoriesRepo.createCategory({ name: unique('Cat'), isActive: true });
    return productsRepo.createProduct({
        name,
        sku: unique('SKU'),
        categoryId: category.id,
        unit: 'unidad',
        salePrice: 10,
        minStock: 1,
        totalStock: 0,
        hasIva: true,
        hasIvaZero: false,
        hasIeps: false,
        isActive: true,
        suppliers: [],
    });
};

const crearMovimiento = (productId: string, createdAt: Timestamp, reason: string) =>
    db().collection('stockMovements').add({
        type: 'adjustment_count',
        productId,
        batchId: 'b',
        quantity: 1,
        reason,
        userId: 'u',
        createdAt,
    });

describe('ventana de lecturas históricas (SPEC 11)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('movimientos sin from: solo los últimos 30 días, y meta.window lo dice', async () => {
        const product = await crearProducto(unique('Prod'));
        await crearMovimiento(product.id, daysAgo(2), 'reciente');
        await crearMovimiento(product.id, daysAgo(90), 'antiguo');

        const result = await inventoryService.listMovements({ productId: product.id });

        expect(result.items.map((m) => m.reason)).toEqual(['reciente']);
        expect(result.meta.window?.to).toBeNull();
        const from = new Date(result.meta.window!.from).getTime();
        expect(Math.abs(Date.now() - 30 * 86_400_000 - from)).toBeLessThan(60_000);
    });

    it('un from explícito mayor al default se respeta', async () => {
        const product = await crearProducto(unique('Prod'));
        await crearMovimiento(product.id, daysAgo(2), 'reciente');
        await crearMovimiento(product.id, daysAgo(90), 'antiguo');

        const result = await inventoryService.listMovements({
            productId: product.id,
            from: daysAgo(120).toDate().toISOString(),
        });

        expect(result.items).toHaveLength(2);
    });

    it('search no enriquece (no lee categoría) filas descartadas', async () => {
        const wanted = await crearProducto(unique('Buscado'));
        const other = await crearProducto(unique('Otro'));
        await crearMovimiento(wanted.id, daysAgo(1), 'x');
        await crearMovimiento(other.id, daysAgo(1), 'x');
        await crearMovimiento(other.id, daysAgo(1), 'x');

        const categorySpy = jest.spyOn(categoriesRepo, 'getCategoryById');
        const result = await inventoryService.listMovements({ search: wanted.name });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].productId).toBe(wanted.id);
        // Solo la categoría del producto de la fila devuelta.
        expect(categorySpy).toHaveBeenCalledTimes(1);
        expect(categorySpy).toHaveBeenCalledWith(wanted.categoryId);
    });

    it('la última visita del paciente se obtiene con una sola lectura', async () => {
        const patient = await patientsRepo.createPatient({
            firstName: unique('Paciente'),
            lastName: unique('Apellido'),
            birthDate: Timestamp.fromDate(new Date('1990-01-01')),
            sex: 'male',
            allergies: [],
            chronicConditions: [],
            isActive: true,
        });
        const visitas = Array.from({ length: 12 }, (_, i) => daysAgo(i + 1));
        await Promise.all(
            visitas.map((visitedAt) =>
                db().collection('medicalRecords').add({
                    patientId: patient.id,
                    patientName: 'x',
                    visitedAt,
                    type: 'consultation',
                    attachments: [],
                    createdAt: visitedAt,
                    updatedAt: visitedAt,
                }),
            ),
        );

        const overview = await patientsService.getPatientOverview(patient.id);
        expect(overview.lastVisitAt?.toMillis()).toBe(visitas[0].toMillis());
        expect(overview.recordCount).toBe(12);
    });

    it('paciente sin visitas: lastVisitAt null', async () => {
        const patient = await patientsRepo.createPatient({
            firstName: unique('Paciente'),
            lastName: unique('Apellido'),
            birthDate: Timestamp.fromDate(new Date('1990-01-01')),
            sex: 'male',
            allergies: [],
            chronicConditions: [],
            isActive: true,
        });
        const overview = await patientsService.getPatientOverview(patient.id);
        expect(overview.lastVisitAt).toBeNull();
    });
});
