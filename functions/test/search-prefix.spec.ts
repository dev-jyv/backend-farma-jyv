import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

import * as customersRepo from '../src/repositories/customers.repository';
import * as patientsRepo from '../src/repositories/patients.repository';
import * as rolesRepo from '../src/repositories/roles.repository';
import * as usersRepo from '../src/repositories/users.repository';
import { normalizeSearchName } from '../src/utils/search-name';
import { backfillCollection, TARGETS } from '../src/scripts/backfill-search-name';

/**
 * SPEC 10: buscar por nombre es un rango por prefijo sobre `searchName`, no una
 * lectura de la colección completa.
 */

const unique = (label: string) =>
    `${label}${Math.random().toString(36).slice(2, 10).replace(/[0-9]/g, 'x')}`;

describe('normalizeSearchName', () => {
    it('quita acentos, mayúsculas y espacios sobrantes', () => {
        expect(normalizeSearchName('  GarCÍA   Pérez ')).toBe('garcia perez');
    });
});

describe('Búsqueda por prefijo (SPEC 10)', () => {
    it('clientes: "García" y "garcia" encuentran al mismo cliente', async () => {
        const base = unique('zq');
        const created = await customersRepo.createCustomer({ name: `${base} García` });
        const [a, b] = await Promise.all([
            customersRepo.listCustomers({ search: `${base} García` }),
            customersRepo.listCustomers({ search: `${base.toUpperCase()} garcia` }),
        ]);
        expect(a.items.map((c) => c.id)).toEqual([created.id]);
        expect(b.items.map((c) => c.id)).toEqual([created.id]);
    });

    it('clientes: el prefijo acota los resultados y respeta limit', async () => {
        const base = unique('gar');
        for (let i = 0; i < 4; i += 1) {
            await customersRepo.createCustomer({ name: `${base} ${i}` });
        }
        await customersRepo.createCustomer({ name: unique('otro') });

        const page = await customersRepo.listCustomers({ search: base, limit: 2 });
        expect(page.items).toHaveLength(2);
        expect(page.total).toBe(4);
        // Dos personas con el mismo nombre: ambas aparecen.
        await customersRepo.createCustomer({ name: `${base} 0` });
        const dup = await customersRepo.listCustomers({ search: `${base} 0` });
        expect(dup.items).toHaveLength(2);
    });

    it('clientes: caracteres especiales se tratan como texto literal', async () => {
        const base = unique('esp');
        await customersRepo.createCustomer({ name: `${base} a.b` });
        const hit = await customersRepo.listCustomers({ search: `${base} a.b` });
        const miss = await customersRepo.listCustomers({ search: `${base} a*` });
        expect(hit.items).toHaveLength(1);
        expect(miss.items).toHaveLength(0);
    });

    it('clientes: término vacío conserva el listado normal', async () => {
        await customersRepo.createCustomer({ name: unique('lista') });
        const all = await customersRepo.listCustomers({ search: '   ', limit: 5 });
        expect(all.items.length).toBeGreaterThan(0);
    });

    it('clientes: editar el nombre actualiza searchName en la misma escritura', async () => {
        const viejo = unique('viejo');
        const nuevo = unique('nuevo');
        const c = await customersRepo.createCustomer({ name: viejo });
        await customersRepo.updateCustomer(c.id, { name: nuevo });
        const doc = await admin.firestore().collection('customers').doc(c.id).get();
        expect(doc.get('searchName')).toBe(normalizeSearchName(nuevo));
        expect((await customersRepo.listCustomers({ search: viejo })).items).toHaveLength(0);
        expect((await customersRepo.listCustomers({ search: nuevo })).items).toHaveLength(1);
    });

    it('pacientes: prefijo del nombre, searchName al día y sin campos nuevos', async () => {
        const first = unique('Mar');
        const created = await patientsRepo.createPatient({
            firstName: first,
            lastName: 'Núñez',
            birthDate: Timestamp.fromDate(new Date('1990-01-01')),
            sex: 'female',
            allergies: [],
            chronicConditions: [],
            isActive: true,
        });
        expect(created).not.toHaveProperty('searchName');

        const found = await patientsRepo.listPatients({ search: first.toUpperCase() });
        expect(found.items.map((p) => p.id)).toEqual([created.id]);
        expect(found.items[0]).not.toHaveProperty('searchName');

        await patientsRepo.updatePatient(created.id, { lastName: 'Ortíz' });
        const doc = await admin.firestore().collection('patients').doc(created.id).get();
        expect(doc.get('searchName')).toBe(normalizeSearchName(`${first} Ortíz`));

        await patientsRepo.updatePatient(created.id, { isActive: false });
        expect((await patientsRepo.listPatients({ search: first })).items).toHaveLength(0);
        expect(
            (await patientsRepo.listPatients({ search: first, includeInactive: true })).items,
        ).toHaveLength(1);
    });

    it('usuarios: busca por prefijo de displayName y combina con filtros', async () => {
        const base = unique('usr');
        const uid = unique('uid');
        await usersRepo.createUserProfile(uid, {
            email: `${uid}@x.test`,
            displayName: `${base} Álvarez`,
            roleId: 'rol-x',
            isActive: true,
        } as never);
        const hit = await usersRepo.listUserProfiles({
            search: `${base} alv`,
            roleId: 'rol-x',
            activeOnly: true,
        });
        expect(hit.items.map((u) => u.id)).toEqual([uid]);

        await usersRepo.updateUserProfile(uid, { displayName: `${base} Zeta` });
        const doc = await admin.firestore().collection('users').doc(uid).get();
        expect(doc.get('searchName')).toBe(normalizeSearchName(`${base} Zeta`));
        expect((await usersRepo.listUserProfiles({ search: `${base} alv` })).items).toHaveLength(0);
    });

    it('roles: busca por prefijo del nombre', async () => {
        const base = unique('rol');
        const role = await rolesRepo.createRole({
            name: `${base} Gerente`,
            slug: base,
            permissions: [],
            isSystem: false,
            isActive: true,
        });
        const hit = await rolesRepo.listRoles({ search: base.toUpperCase(), activeOnly: true });
        expect(hit.items.map((r) => r.id)).toEqual([role.id]);
        await rolesRepo.updateRole(role.id, { name: `${base} Jefe` });
        const doc = await admin.firestore().collection('roles').doc(role.id).get();
        expect(doc.get('searchName')).toBe(normalizeSearchName(`${base} Jefe`));
    });
});

describe('Backfill de searchName', () => {
    it('dry-run no escribe; la corrida real rellena y es idempotente', async () => {
        const name = unique('Legado');
        const ref = await admin
            .firestore()
            .collection('customers')
            .add({ name: `${name} Ñandú`, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
        const target = TARGETS.find((t) => t.collection === 'customers')!;

        const dry = await backfillCollection(target, true);
        expect(dry.missing).toBeGreaterThanOrEqual(1);
        expect(dry.written).toBe(0);
        expect((await ref.get()).get('searchName')).toBeUndefined();
        expect((await customersRepo.listCustomers({ search: name })).items).toHaveLength(0);

        const real = await backfillCollection(target, false);
        expect(real.written).toBe(real.missing);
        expect((await ref.get()).get('searchName')).toBe(normalizeSearchName(`${name} Ñandú`));
        expect((await customersRepo.listCustomers({ search: name })).items).toHaveLength(1);

        const again = await backfillCollection(target, false);
        expect(again.missing).toBe(0);
    });
});
