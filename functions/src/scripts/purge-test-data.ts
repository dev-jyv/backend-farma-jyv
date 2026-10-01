import * as admin from 'firebase-admin';

/**
 * Elimina de producción las ventas y cortes de PRUEBA hechos desde el POS en modo
 * dev mientras ese modo apuntaba a producción (5 al 24 de septiembre de 2026).
 * Los ids salen del SQLite local de esa máquina; la lista es cerrada a propósito.
 *
 * Orden:
 *   1. Verifica que cada venta y sesión exista y que ninguna OTRA venta, devolución
 *      o cobro cuelgue de esas sesiones. Si encuentra algo fuera de la lista, aborta.
 *   2. Anula con `voidSale` las ventas que siguen vivas: restaura los lotes y
 *      `products.totalStock` y contra-asienta el libro de controlados, como
 *      cualquier anulación.
 *   3. Borra físicamente ventas, movimientos de stock, renglones del libro, llaves
 *      de idempotencia, bitácora de esas entidades, sesiones, movimientos de caja,
 *      lecturas X y registros no conciliados.
 *   4. Deja UNA entrada de bitácora `maintenance.test_data_purged` con lo borrado.
 *
 * Los contadores de folio no se retroceden (V-000021 sigue siendo el siguiente).
 *
 * Uso (requiere credenciales de producción: ADC o service-account.json):
 *   npm run build && node lib/scripts/purge-test-data.js --project farma-jyv            # dry-run
 *   npm run build && node lib/scripts/purge-test-data.js --project farma-jyv --execute  # escribe
 *
 * Tomar antes un respaldo manual (RUNBOOK §4) a `manual/pre-borrado-pruebas-<fecha>`.
 */

// Las 7 ventas y 9 sesiones del 5-7 de septiembre ya se borraron el 2026-09-16
// (RUNBOOK, respaldo manual/pre-borrado-20260916T194704). Quedan dos cortes del 24.
const SALE_IDS: string[] = [];

const SESSION_IDS = [
    'jSUP8JbooILlK7T3Gqls', // 2026-09-24 14:53
    'UWFXYYe2K1080Wl3GnkJ', // 2026-09-24 22:57
];

const EXPECTED_PROJECT = 'farma-jyv';
const ACTOR = 'script:purge-test-data';

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
};

type Ref = FirebaseFirestore.DocumentReference;

const main = async (): Promise<void> => {
    const project = argValue('--project');
    const execute = process.argv.includes('--execute');
    if (project !== EXPECTED_PROJECT) {
        console.error(`Pasa --project ${EXPECTED_PROJECT} (recibido: ${project}).`);
        process.exit(1);
    }
    if (process.env.FIRESTORE_EMULATOR_HOST) {
        console.error('FIRESTORE_EMULATOR_HOST está definido: este script es para producción.');
        process.exit(1);
    }

    admin.initializeApp({ projectId: project });
    const { db } = await import('../utils/firestore');
    const firestore = db();

    const whereIn = async (collection: string, field: string, values: string[]) => {
        const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
        for (let i = 0; i < values.length; i += 30) {
            const snap = await firestore.collection(collection)
                .where(field, 'in', values.slice(i, i + 30)).get();
            docs.push(...snap.docs);
        }
        return docs;
    };
    const refsIn = async (collection: string, field: string, values: string[]) =>
        (await whereIn(collection, field, values)).map((doc) => doc.ref);

    // --- 1. Verificación -----------------------------------------------------
    const problems: string[] = [];
    const saleDocs = await Promise.all(SALE_IDS.map((id) => firestore.doc(`sales/${id}`).get()));
    const sessionDocs = await Promise.all(
        SESSION_IDS.map((id) => firestore.doc(`cashSessions/${id}`).get()),
    );
    for (const doc of saleDocs) {
        if (!doc.exists) {
            problems.push(`venta ${doc.id} no existe`);
            continue;
        }
        const data = doc.data()!;
        if (!SESSION_IDS.includes(data.cashSessionId)) {
            problems.push(`venta ${doc.id}: sesión ${data.cashSessionId} fuera de la lista`);
        }
        if ((data.refundedTotal ?? 0) > 0) problems.push(`venta ${doc.id} tiene devoluciones`);
    }
    for (const doc of sessionDocs) {
        if (!doc.exists) problems.push(`sesión ${doc.id} no existe`);
        else if (!doc.data()!.closedAt) problems.push(`sesión ${doc.id} sigue abierta`);
    }

    const salesInSessions = await whereIn('sales', 'cashSessionId', SESSION_IDS);
    for (const doc of salesInSessions) {
        if (SALE_IDS.includes(doc.id)) continue;
        const { cashSessionId, folio } = doc.data();
        problems.push(`la sesión ${cashSessionId} tiene otra venta ${doc.id} (${folio})`);
    }
    const returns = [
        ...(await whereIn('saleReturns', 'saleId', SALE_IDS)),
        ...(await whereIn('saleReturns', 'cashSessionId', SESSION_IDS)),
    ];
    if (returns.length) problems.push(`hay ${returns.length} devoluciones ligadas; revisar a mano`);

    if (problems.length) {
        console.error('Abortado, nada se escribió:');
        problems.forEach((p) => console.error(`  - ${p}`));
        process.exit(1);
    }

    const collectDeletions = async (): Promise<Record<string, Ref[]>> => {
        const bySession = (collection: string) => refsIn(collection, 'cashSessionId', SESSION_IDS);
        const groups: Record<string, Ref[]> = {
            sales: saleDocs.map((d) => d.ref),
            stockMovements: await refsIn('stockMovements', 'referenceId', SALE_IDS),
            controlledSalesLedger: await refsIn('controlledSalesLedger', 'saleId', SALE_IDS),
            saleIdempotencyKeys: await refsIn('saleIdempotencyKeys', 'saleId', SALE_IDS),
            cashSessions: sessionDocs.map((d) => d.ref),
            cashMovements: await bySession('cashMovements'),
            cashReadings: await bySession('cashReadings'),
            unreconciledSales: await bySession('unreconciledSales'),
            bankMovements: await bySession('bankMovements'),
            accruedExpenses: await bySession('accruedExpenses'),
        };
        const entityIds = [
            ...SALE_IDS, ...SESSION_IDS,
            ...groups.unreconciledSales.map((r) => r.id),
            ...groups.cashMovements.map((r) => r.id),
        ];
        groups.auditLogs = await refsIn('auditLogs', 'entityId', entityIds);
        return groups;
    };

    const toVoid = saleDocs.filter((d) => !d.data()!.voidedAt).map((d) => d.id);
    const preview = await collectDeletions();
    console.log(`Proyecto: ${project}  Modo: ${execute ? 'EJECUTAR' : 'dry-run'}`);
    console.log(`Ventas a anular primero: ${toVoid.length} (${toVoid.join(', ') || '-'})`);
    console.log('Documentos a borrar (la anulación agrega movimientos que también se borran):');
    for (const [name, refs] of Object.entries(preview)) {
        console.log(`  ${name.padEnd(22)} ${refs.length}`);
    }

    if (!execute) {
        console.log('\nDry-run: nada se escribió. Repite con --execute para aplicar.');
        return;
    }

    // --- 2. Anular -----------------------------------------------------------
    const { voidSale } = await import('../services/sales.service');
    for (const id of toVoid) {
        await voidSale(id, ACTOR, 'admin');
        console.log(`Anulada ${id}`);
    }

    // --- 3. Borrar -----------------------------------------------------------
    const groups = await collectDeletions();
    const all = Object.values(groups).flat();
    for (let i = 0; i < all.length; i += 400) {
        const batch = firestore.batch();
        all.slice(i, i + 400).forEach((ref) => batch.delete(ref));
        await batch.commit();
    }
    const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
    console.log('Borrado:', counts);

    // --- 4. Rastro -----------------------------------------------------------
    await firestore.collection('auditLogs').add({
        action: 'maintenance.test_data_purged',
        entity: 'maintenance',
        entityId: 'purge-test-data-2026-09',
        userId: ACTOR,
        summary: 'Borrado de ventas y cortes de prueba hechos por el POS dev contra producción',
        metadata: { saleIds: SALE_IDS, sessionIds: SESSION_IDS, voided: toVoid, counts },
        createdAt: admin.firestore.Timestamp.now(),
    });
    console.log('Listo. Queda una entrada maintenance.test_data_purged en auditLogs.');
};

main().catch((error) => {
    console.error('Falló:', error);
    process.exit(1);
});
