import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

/**
 * Registra por lote ventas no conciliadas pendientes, con el mismo camino que el
 * botón "Registrar" del panel (`resolveUnreconciledSale`, SPEC 53): venta offline
 * con el payload guardado, su llave de idempotencia original y la auditoría
 * `sale.unreconciled_resolved` a nombre de `--as`.
 *
 * Nació por el 06/11: 22 ventas de dos turnos que el POS creó y cerró en el
 * servidor al sincronizar tarde quedaron en conciliación con "El turno de caja
 * ya está cerrado".
 *
 * **En seco por omisión**: lista lo que registraría. Con `--apply` escribe. Es
 * idempotente: una ya resuelta se salta, y `createSale` no duplica con la misma
 * llave.
 *
 * Uso:
 *   npm run register:unreconciled -- --project farma-jyv --from 2026-11-05 \
 *     --reason "El turno de caja ya está cerrado"
 *   npm run register:unreconciled -- --project farma-jyv --from 2026-11-05 \
 *     --reason "El turno de caja ya está cerrado" --as <uid admin> --apply
 *
 * Filtros: `--from YYYY-MM-DD` (alta en conciliación, hora de México, obligatorio),
 * `--reason <texto>` (el motivo debe contenerlo), `--ids a,b` (ids exactos).
 * Requiere credenciales locales (ADC) o `FIRESTORE_EMULATOR_HOST`.
 */

interface Options {
    project: string;
    from: string;
    reason: string | null;
    ids: string[] | null;
    as: string | null;
    apply: boolean;
}

const valueOf = (argv: string[], flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index !== -1) {
        return argv[index + 1] ?? null;
    }
    const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : null;
};

const parseOptions = (argv: string[]): Options => {
    const project = valueOf(argv, '--project');
    const from = valueOf(argv, '--from');
    if (!project) {
        throw new Error('Falta --project (farma-jyv, farma-jyv-dev o demo-farmajyv)');
    }
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        throw new Error('Falta --from YYYY-MM-DD');
    }
    const apply = argv.includes('--apply');
    const as = valueOf(argv, '--as');
    if (apply && !as) {
        throw new Error('--apply exige --as <uid> de quien autoriza (admin o gerente)');
    }
    const ids = valueOf(argv, '--ids');
    return {
        project,
        from,
        reason: valueOf(argv, '--reason'),
        ids: ids ? ids.split(',').map((id) => id.trim()).filter(Boolean) : null,
        as,
        apply,
    };
};

const formatLocal = (value: Timestamp | null | undefined): string =>
    value
        ? value.toDate().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })
        : '-';

const run = async (): Promise<void> => {
    const options = parseOptions(process.argv.slice(2));
    admin.initializeApp({ projectId: options.project });

    // Después de `initializeApp`: los módulos de la app asumen la app por omisión.
    const { db } = await import('../utils/firestore');
    const { resolveUnreconciledSale } = await import('../services/unreconciled-sales.service');
    const usersRepo = await import('../repositories/users.repository');
    const rolesRepo = await import('../repositories/roles.repository');
    const { resolveRangeBoundary, APP_TIME_ZONE } = await import('../utils/timezone');

    let actor: { userId: string; roleSlug?: string } | null = null;
    if (options.as) {
        const profile = await usersRepo.getUserProfile(options.as);
        if (!profile?.isActive) {
            throw new Error(`--as ${options.as}: el usuario no existe o está inactivo`);
        }
        const role = profile.roleId ? await rolesRepo.getRoleById(profile.roleId) : null;
        if (!role || !['admin', 'manager'].includes(role.slug)) {
            const slug = role?.slug ?? '?';
            throw new Error(`--as ${options.as}: debe ser admin o gerente (es ${slug})`);
        }
        actor = { userId: options.as, roleSlug: role.slug };
    }

    const desde = Timestamp.fromDate(resolveRangeBoundary(options.from, APP_TIME_ZONE, 'start'));
    const snapshot = await db().collection('unreconciledSales')
        .where('createdAt', '>=', desde)
        .orderBy('createdAt')
        .get();

    const pendientes = snapshot.docs.filter((doc) => {
        const data = doc.data();
        if (data.resolvedAt) return false;
        if (options.ids && !options.ids.includes(doc.id)) return false;
        if (options.reason && !String(data.reason ?? '').includes(options.reason)) return false;
        return true;
    });

    console.log(`${options.apply ? 'REGISTRANDO' : 'EN SECO'} · ${options.project} · ` +
        `${pendientes.length} pendientes`);

    let ok = 0;
    let fallidas = 0;
    let total = 0;
    for (const doc of pendientes) {
        const data = doc.data();
        const linea = `${doc.id} | $${data.total} | vendida ${formatLocal(data.occurredAt)}`;
        if (!options.apply || !actor) {
            console.log(`  ${linea}`);
            total += Number(data.total ?? 0);
            continue;
        }
        try {
            const { sale } = await resolveUnreconciledSale(doc.id, { action: 'register' }, actor);
            ok += 1;
            total += Number(data.total ?? 0);
            console.log(`  OK  ${linea} -> ${sale?.folio ?? '?'}` +
                `${sale?.lateSync ? ' (lateSync)' : ''}`);
        } catch (error) {
            fallidas += 1;
            console.log(`  ERR ${linea} -> ${(error as Error).message}`);
        }
    }

    console.log(options.apply
        ? `\nRegistradas ${ok}, fallidas ${fallidas}, monto registrado $${total.toFixed(2)}`
        : `\nMonto $${total.toFixed(2)}. Repite con --as <uid> --apply para registrarlas.`);
    process.exit(fallidas ? 1 : 0);
};

run().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
});
