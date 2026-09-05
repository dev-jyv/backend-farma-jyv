import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
    RulesTestEnvironment,
    RulesTestContext,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, setLogLevel } from 'firebase/firestore';

// Cada denegación esperada imprime un PERMISSION_DENIED del SDK; con ~200 de
// ellas la salida del runner deja de ser legible y los fallos reales se pierden.
setLogLevel('silent');

/**
 * Estas pruebas ejercen `firestore.rules` de verdad: el emulador se arranca desde
 * la raíz del repo (ver `test:rules` en el package.json raíz) y además el archivo
 * se carga aquí explícitamente, para que la suite no dependa de qué reglas tenga
 * cargadas el emulador cuando alguien lo levantó a mano.
 *
 * Va aparte de `functions/test/**` porque esa suite corre con `emulators:exec`
 * desde `functions/`, donde no se ve el `firebase.json` de la raíz y por tanto el
 * emulador arranca con reglas abiertas. Mezclarlas haría que estas pruebas
 * pasaran sin ejercer nada.
 */

const RULES = readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8');

const [EMULATOR_HOST, EMULATOR_PORT] = (
    process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080'
).split(':');

const UID_ADMIN = 'uid-admin';
const UID_CAJERO_A = 'uid-cajero-a';
const UID_CAJERO_B = 'uid-cajero-b';
const UID_MANAGER = 'uid-manager';
const UID_DOCTOR = 'uid-doctor';

/**
 * Forma real del claim que emite `AuthService`/`auth.guard.ts`: el token no lleva
 * permisos por área, solo el rol. Si las pruebas inventaran otro claim estarían
 * midiendo una autorización que en producción nunca ocurre.
 */
function claims(roleSlug: string) {
    return {
        roleId: `role-${roleSlug}`,
        roleSlug,
        roleName: roleSlug,
        permissionsVersion: 1,
    };
}

/**
 * Todas las colecciones nombradas en las reglas. Sirve para el barrido de
 * escritura: `allow write: if false` debe valer para cada una, sin excepción.
 */
const COLECCIONES = [
    'users',
    'roles',
    'categories',
    'suppliers',
    'products',
    'batches',
    'stockMovements',
    'inventoryEntries',
    'sales',
    'inventoryCounts',
    'controlledSalesLedger',
    'auditLogs',
    'cashReadings',
    'saleReturns',
    'invoices',
    'cashSessions',
    'patients',
    'medicalRecords',
    'appointments',
    'pharmacyServices',
    'serviceProviders',
];

/** Colección que las reglas no mencionan: debe caer en el deny por omisión. */
const COLECCION_INEXISTENTE = 'coleccionQueNoExisteEnLasReglas';

let testEnv: RulesTestEnvironment;

let admin: RulesTestContext;
let cajeroA: RulesTestContext;
let cajeroB: RulesTestContext;
let manager: RulesTestContext;
let doctor: RulesTestContext;
let anonimo: RulesTestContext;
let sinRol: RulesTestContext;

beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: 'farma-jyv-rules',
        firestore: {
            rules: RULES,
            host: EMULATOR_HOST,
            port: Number(EMULATOR_PORT),
        },
    });

    admin = testEnv.authenticatedContext(UID_ADMIN, claims('admin'));
    cajeroA = testEnv.authenticatedContext(UID_CAJERO_A, claims('cashier'));
    cajeroB = testEnv.authenticatedContext(UID_CAJERO_B, claims('cashier'));
    manager = testEnv.authenticatedContext(UID_MANAGER, claims('manager'));
    doctor = testEnv.authenticatedContext(UID_DOCTOR, claims('doctor'));
    anonimo = testEnv.unauthenticatedContext();
    // Existe de verdad: un usuario recién creado en Firebase Auth al que todavía
    // no se le asignaron claims. Autenticado, pero no es personal de la farmacia.
    sinRol = testEnv.authenticatedContext('uid-sin-rol', {});
});

afterAll(async () => {
    await testEnv?.cleanup();
});

beforeEach(async () => {
    await testEnv.clearFirestore();

    // Sembrar con las reglas desactivadas: `allow write: if false` también aplica
    // a la preparación, así que no hay forma de crear los documentos "como usuario".
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();

        await setDoc(doc(db, 'cashSessions/turno-a'), {
            openedBy: UID_CAJERO_A,
            status: 'open',
            openingFloat: 1000,
        });
        await setDoc(doc(db, 'cashSessions/turno-b'), {
            openedBy: UID_CAJERO_B,
            status: 'open',
            openingFloat: 1500,
        });

        await setDoc(doc(db, 'sales/venta-a'), {
            cashierId: UID_CAJERO_A,
            total: 250,
            costTotal: 120,
        });
        await setDoc(doc(db, 'sales/venta-b'), {
            cashierId: UID_CAJERO_B,
            total: 480,
            costTotal: 300,
        });

        await setDoc(doc(db, 'cashReadings/lectura-1'), {
            cashSessionId: 'turno-a',
            expected: 1000,
        });
        await setDoc(doc(db, 'saleReturns/devolucion-1'), { saleId: 'venta-a', amount: 250 });
        await setDoc(doc(db, 'batches/lote-1'), { productId: 'p1', costPrice: 42.5, quantity: 10 });

        await setDoc(doc(db, `users/${UID_CAJERO_A}`), { displayName: 'Cajero A' });
        await setDoc(doc(db, `users/${UID_CAJERO_B}`), { displayName: 'Cajero B' });

        // Un documento por colección para que las pruebas de escritura ejerzan
        // tanto `create` (documento nuevo) como `update`/`delete` (existente).
        for (const coleccion of [...COLECCIONES, COLECCION_INEXISTENTE]) {
            await setDoc(doc(db, `${coleccion}/existente`), { seed: true });
        }
    });
});

describe('firestore.rules — turnos de caja (cashSessions)', () => {
    it('el cajero lee su propio turno', async () => {
        await assertSucceeds(getDoc(doc(cajeroA.firestore(), 'cashSessions/turno-a')));
    });

    it('el cajero NO lee el turno de otro cajero', async () => {
        await assertFails(getDoc(doc(cajeroA.firestore(), 'cashSessions/turno-b')));
    });

    it('el cajero B tampoco lee el turno del cajero A (la restricción es simétrica)', async () => {
        await assertFails(getDoc(doc(cajeroB.firestore(), 'cashSessions/turno-a')));
    });

    it('el admin lee los turnos de ambos cajeros', async () => {
        await assertSucceeds(getDoc(doc(admin.firestore(), 'cashSessions/turno-a')));
        await assertSucceeds(getDoc(doc(admin.firestore(), 'cashSessions/turno-b')));
    });

    it('el manager NO lee turnos ajenos: auditar caja es exclusivo de admin', async () => {
        await assertFails(getDoc(doc(manager.firestore(), 'cashSessions/turno-a')));
    });

    it('sin autenticar no se lee ningún turno', async () => {
        await assertFails(getDoc(doc(anonimo.firestore(), 'cashSessions/turno-a')));
    });
});

describe('firestore.rules — ventas (sales)', () => {
    it('el cajero lee su propia venta', async () => {
        await assertSucceeds(getDoc(doc(cajeroA.firestore(), 'sales/venta-a')));
    });

    it('el cajero NO lee la venta de otro cajero (ahí viaja el margen: costTotal)', async () => {
        await assertFails(getDoc(doc(cajeroA.firestore(), 'sales/venta-b')));
    });

    it('el admin lee cualquier venta', async () => {
        await assertSucceeds(getDoc(doc(admin.firestore(), 'sales/venta-a')));
        await assertSucceeds(getDoc(doc(admin.firestore(), 'sales/venta-b')));
    });

    it('el manager NO lee ventas que no son suyas', async () => {
        await assertFails(getDoc(doc(manager.firestore(), 'sales/venta-a')));
    });

    it('sin autenticar no se lee ninguna venta', async () => {
        await assertFails(getDoc(doc(anonimo.firestore(), 'sales/venta-a')));
    });
});

describe('firestore.rules — auditoría de caja (cashReadings, saleReturns)', () => {
    for (const ruta of ['cashReadings/lectura-1', 'saleReturns/devolucion-1']) {
        it(`el admin lee ${ruta}`, async () => {
            await assertSucceeds(getDoc(doc(admin.firestore(), ruta)));
        });

        it(`el cajero NO lee ${ruta}`, async () => {
            await assertFails(getDoc(doc(cajeroA.firestore(), ruta)));
        });

        it(`el manager NO lee ${ruta}`, async () => {
            await assertFails(getDoc(doc(manager.firestore(), ruta)));
        });

        it(`el doctor NO lee ${ruta}`, async () => {
            await assertFails(getDoc(doc(doctor.firestore(), ruta)));
        });

        it(`sin autenticar no se lee ${ruta}`, async () => {
            await assertFails(getDoc(doc(anonimo.firestore(), ruta)));
        });
    }
});

describe('firestore.rules — lotes (batches) y el costo de compra', () => {
    // Ahí vive `costPrice` y el consultorio no compra inventario.
    it('el doctor NO lee lotes', async () => {
        await assertFails(getDoc(doc(doctor.firestore(), 'batches/lote-1')));
    });

    it('el cajero NO lee lotes: la caja recibe el catálogo por GET /products/sync', async () => {
        await assertFails(getDoc(doc(cajeroA.firestore(), 'batches/lote-1')));
    });

    it('admin y manager sí leen lotes: son quienes administran inventario', async () => {
        await assertSucceeds(getDoc(doc(admin.firestore(), 'batches/lote-1')));
        await assertSucceeds(getDoc(doc(manager.firestore(), 'batches/lote-1')));
    });

    it('sin autenticar no se leen lotes', async () => {
        await assertFails(getDoc(doc(anonimo.firestore(), 'batches/lote-1')));
    });
});

describe('firestore.rules — toda escritura desde el cliente está denegada', () => {
    const actores = () => [
        ['admin', admin],
        ['cajero', cajeroA],
        ['manager', manager],
        ['doctor', doctor],
        ['anónimo', anonimo],
    ] as [string, RulesTestContext][];

    for (const coleccion of [...COLECCIONES, COLECCION_INEXISTENTE]) {
        it(`nadie crea, actualiza ni borra en ${coleccion}`, async () => {
            for (const [nombre, actor] of actores()) {
                const db = actor.firestore();
                await assertFails(
                    setDoc(doc(db, `${coleccion}/nuevo-${nombre}`), { intruso: true }),
                );
                await assertFails(
                    updateDoc(doc(db, `${coleccion}/existente`), { intruso: true }),
                );
                await assertFails(deleteDoc(doc(db, `${coleccion}/existente`)));
            }
        });
    }
});

describe('firestore.rules — colección no declarada en las reglas', () => {
    it('nadie la lee, ni siquiera el admin: rige el deny por omisión', async () => {
        for (const actor of [admin, cajeroA, manager, doctor, anonimo]) {
            await assertFails(
                getDoc(doc(actor.firestore(), `${COLECCION_INEXISTENTE}/existente`)),
            );
        }
    });
});

describe('firestore.rules — sin autenticar todo está denegado', () => {
    for (const coleccion of [...COLECCIONES, COLECCION_INEXISTENTE]) {
        it(`el anónimo no lee ${coleccion}`, async () => {
            await assertFails(getDoc(doc(anonimo.firestore(), `${coleccion}/existente`)));
        });
    }
});

describe('firestore.rules — autenticado pero sin claim de rol', () => {
    // `isStaff()` abre el catálogo a cualquiera que traiga roleId o roleSlug. Un
    // token sin claims no debe colarse por ahí: quien aún no tiene rol asignado
    // no es personal.
    for (const coleccion of ['products', 'categories', 'suppliers', 'roles']) {
        it(`no lee ${coleccion}`, async () => {
            await assertFails(getDoc(doc(sinRol.firestore(), `${coleccion}/existente`)));
        });
    }

    it('no lee ventas ajenas ni turnos ajenos', async () => {
        await assertFails(getDoc(doc(sinRol.firestore(), 'sales/venta-a')));
        await assertFails(getDoc(doc(sinRol.firestore(), 'cashSessions/turno-a')));
    });

    it('tampoco escribe en ninguna parte', async () => {
        await assertFails(setDoc(doc(sinRol.firestore(), 'products/nuevo'), { x: 1 }));
    });
});

describe('firestore.rules — perfil propio (users)', () => {
    it('cada quien lee su propio documento de usuario', async () => {
        await assertSucceeds(getDoc(doc(cajeroA.firestore(), `users/${UID_CAJERO_A}`)));
    });

    it('nadie lee el documento de otro usuario, ni el admin', async () => {
        await assertFails(getDoc(doc(cajeroA.firestore(), `users/${UID_CAJERO_B}`)));
        await assertFails(getDoc(doc(admin.firestore(), `users/${UID_CAJERO_A}`)));
    });
});
