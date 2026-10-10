import { Timestamp } from 'firebase-admin/firestore';
import * as patientsRepo from '../src/repositories/patients.repository';

/**
 * `listPatients` sin término de búsqueda pasó a paginar en Firestore, y con eso
 * el filtro de inactivos pasó de la memoria a la consulta.
 *
 * Eso es justo lo que se fija aquí: el paciente dado de baja no vuelve al
 * padrón por defecto —el expediente se conserva (NOM-004) pero deja de
 * listarse— y sigue estando cuando se piden los inactivos. Un filtro que se
 * mueve de capa es donde se cuela el fallo silencioso.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const crearPaciente = async (nombre: string) =>
    patientsRepo.createPatient({
        firstName: nombre,
        lastName: unique('Apellido'),
        birthDate: Timestamp.fromDate(new Date('1990-01-01')),
        sex: 'male',
        allergies: [],
        chronicConditions: [],
        isActive: true,
    });

describe('listPatients (página resuelta en Firestore)', () => {
    it('saca del padrón al paciente inactivo pero lo conserva si se piden', async () => {
        const nombre = unique('Paciente');
        const paciente = await crearPaciente(nombre);

        const antes = await patientsRepo.listPatients({ page: 1, limit: 100 });
        expect(antes.items.some((item) => item.id === paciente.id)).toBe(true);

        await patientsRepo.updatePatient(paciente.id, { isActive: false });

        const activos = await patientsRepo.listPatients({ page: 1, limit: 100 });
        expect(activos.items.some((item) => item.id === paciente.id)).toBe(false);

        const todos = await patientsRepo.listPatients({
            includeInactive: true,
            page: 1,
            limit: 100,
        });
        expect(todos.items.some((item) => item.id === paciente.id)).toBe(true);
    });

    it('`total` cuenta el padrón activo, no la página leída', async () => {
        const primera = await patientsRepo.listPatients({ page: 1, limit: 1 });
        await crearPaciente(unique('Paciente'));
        const segunda = await patientsRepo.listPatients({ page: 1, limit: 1 });

        expect(segunda.items).toHaveLength(1);
        expect(segunda.total).toBe(primera.total + 1);
    });
});
