import * as admin from 'firebase-admin';

/**
 * Siembra datos ficticios en los EMULADORES locales para desarrollar sin tocar
 * producción ni el proyecto `farma-jyv-dev`.
 *
 * Crea roles de sistema, un usuario por rol (contraseña conocida), una categoría,
 * un proveedor, tres productos con lotes (uno de grupo controlado II) y un
 * paciente. Es idempotente en lo que importa: si el usuario ya existe lo reusa, y
 * si el catálogo ya tiene el SKU semilla no vuelve a crearlo.
 *
 * Uso (con `npm run emulators` corriendo en otra terminal):
 *   npm run seed:emulator
 *
 * Se niega a correr si no detecta los emuladores o si el proyecto no es `demo-*`:
 * un proyecto `demo-` no puede existir en la nube, así que nunca escribe en uno real.
 */

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-farmajyv';
const SEED_PASSWORD = 'Farmacia123!';

const USERS: Array<{ email: string; displayName: string; slug: string }> = [
    { email: 'admin@farmajyv.test', displayName: 'Admin Demo', slug: 'admin' },
    { email: 'gerente@farmajyv.test', displayName: 'Gerente Demo', slug: 'manager' },
    { email: 'cajero@farmajyv.test', displayName: 'Cajero Demo', slug: 'cashier' },
    { email: 'doctor@farmajyv.test', displayName: 'Doctora Demo', slug: 'doctor' },
];

const assertEmulatorOnly = (): void => {
    const problems: string[] = [];
    if (!PROJECT_ID.startsWith('demo-')) {
        problems.push(`el proyecto es "${PROJECT_ID}" y debe empezar con "demo-"`);
    }
    if (!process.env.FIRESTORE_EMULATOR_HOST) problems.push('falta FIRESTORE_EMULATOR_HOST');
    if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
        problems.push('falta FIREBASE_AUTH_EMULATOR_HOST');
    }
    if (problems.length) {
        console.error(`Seed cancelado: ${problems.join('; ')}.`);
        console.error('Corre `npm run seed:emulator`, que fija esas variables por ti.');
        process.exit(1);
    }
};

const main = async (): Promise<void> => {
    assertEmulatorOnly();
    admin.initializeApp({ projectId: PROJECT_ID });

    // Import diferido: los servicios leen `db()` y deben cargarse después de
    // initializeApp con las variables del emulador ya fijadas.
    const { runRoleMigration } = await import('../services/roles.service');
    const { getRoleBySlug } = await import('../repositories/roles.repository');
    const { registerStaff } = await import('../services/auth.service');
    const { createCategory } = await import('../services/categories.service');
    const { createSupplier } = await import('../services/suppliers.service');
    const { recordDirectEntry } = await import('../services/inventory.service');
    const { createPatient } = await import('../services/patients.service');
    const { db } = await import('../utils/firestore');

    await runRoleMigration();
    console.log('Roles de sistema listos.');

    let adminUid = '';
    for (const user of USERS) {
        const role = await getRoleBySlug(user.slug);
        if (!role) throw new Error(`No existe el rol ${user.slug} tras la migración`);
        try {
            const created = await registerStaff({
                email: user.email,
                password: SEED_PASSWORD,
                displayName: user.displayName,
                roleId: role.id,
            });
            if (user.slug === 'admin') adminUid = created.uid;
            console.log(`Usuario ${user.email} (${user.slug}) creado.`);
        } catch {
            const existing = await admin.auth().getUserByEmail(user.email);
            if (user.slug === 'admin') adminUid = existing.uid;
            console.log(`Usuario ${user.email} ya existía; se reusa.`);
        }
    }

    const alreadySeeded = !(await db()
        .collection('products')
        .where('sku', '==', 'DEMO-PARA-500')
        .limit(1)
        .get()).empty;

    if (alreadySeeded) {
        console.log('El catálogo semilla ya existe; no se duplica.');
    } else {
        const category = await createCategory({
            name: 'Analgésicos', description: 'Semilla de desarrollo',
        });
        const supplier = await createSupplier({
            name: 'Distribuidora Demo', email: 'ventas@distribuidora.test',
        });
        const nextYear = new Date();
        nextYear.setFullYear(nextYear.getFullYear() + 1);
        const expiry = nextYear.toISOString().slice(0, 10);

        const item = (
            name: string, sku: string, barcode: string, activeIngredient: string,
            salePrice: number, costPrice: number, quantity: number, lotNumber: string,
            controlledGroup?: 'II',
        ) => ({
            product: {
                name, sku, barcode, activeIngredient, categoryId: category.id, unit: 'caja',
                salePrice, minStock: 5, hasIva: false, hasIvaZero: true, hasIeps: false,
                ...(controlledGroup ? { controlledGroup } : {}),
            },
            lotNumber, expiryDate: expiry, quantity, costPrice,
        });

        await recordDirectEntry({
            supplierId: supplier.id,
            userId: adminUid,
            notes: 'Entrada semilla del emulador',
            items: [
                item('Paracetamol 500 mg 10 tabletas', 'DEMO-PARA-500', '7501000000017',
                    'Paracetamol', 35, 18, 40, 'L-PARA-01'),
                item('Ibuprofeno 400 mg 20 tabletas', 'DEMO-IBU-400', '7501000000024',
                    'Ibuprofeno', 62, 30, 25, 'L-IBU-01'),
                item('Clonazepam 2 mg 30 tabletas', 'DEMO-CLON-2', '7501000000031',
                    'Clonazepam', 180, 95, 10, 'L-CLON-01', 'II'),
            ],
        });
        console.log('Catálogo semilla creado (3 productos con lote, uno de grupo II).');

        await createPatient({
            firstName: 'Paciente', lastName: 'Demo', birthDate: '1990-05-15', sex: 'female',
            phone: '5550000000', allergies: ['Penicilina'], chronicConditions: [],
        } as Parameters<typeof createPatient>[0]);
        console.log('Paciente semilla creado.');
    }

    console.log(`\nListo. Usuarios (contraseña "${SEED_PASSWORD}"):`);
    USERS.forEach((u) => console.log(`  ${u.slug.padEnd(8)} ${u.email}`));
};

main().catch((error) => {
    console.error('Seed falló:', error);
    process.exit(1);
});
