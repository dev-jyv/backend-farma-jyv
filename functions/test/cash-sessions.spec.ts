import * as cashSessionsRepo from '../src/repositories/cash-sessions.repository';
import * as cashMovementsRepo from '../src/repositories/cash-movements.repository';
import * as auditRepo from '../src/repositories/audit-logs.repository';
import * as cashSessionsService from '../src/services/cash-sessions.service';
import { AppError } from '../src/utils/errors';

/**
 * Corte de caja y su auditoría. El eje de estas pruebas es el ajuste pendiente:
 * un corte que no cuadra deja el turno esperando el visto bueno de un admin, y
 * ese visto bueno se da **una sola vez** —aprobar dos veces, o aprobar un turno
 * que nunca tuvo diferencia, borraría el rastro de un faltante.
 *
 * La excepción es el cierre automático de las 24:00: ahí no hay cajero presente
 * a quien pedirle una explicación, así que nunca genera ajuste pendiente.
 */

const unique = (label: string) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const abrirTurno = async (openingAmount = 1000, openedBy = unique('cajero')) =>
    cashSessionsRepo.createCashSession({
        openedBy,
        openingAmount,
        expectedCashAmount: null,
        countedCashAmount: null,
        cashDifference: null,
        summary: null,
        closedBy: null,
        closedAt: null,
    });

/** Cierra el turno y devuelve el documento tal como quedó en Firestore. */
const cerrarTurno = async (
    sessionId: string,
    openedBy: string,
    countedCashAmount: number,
    options: { autoClosedByExpiry?: boolean } = {},
) => {
    await cashSessionsService.closeSession(
        sessionId,
        openedBy,
        'cashier',
        countedCashAmount,
        options,
    );
    return cashSessionsRepo.getCashSessionById(sessionId);
};

/** Turno cerrado con faltante, listo para que un admin revise el ajuste. */
const turnoConAjustePendiente = async (countedCashAmount = 950) => {
    const session = await abrirTurno(1000);
    const closed = await cerrarTurno(session.id, session.openedBy, countedCashAmount);
    return { session, closed: closed! };
};

describe('cash-sessions.service - closeSession y el ajuste pendiente', () => {
    it('un faltante deja el turno pendiente de revisión', async () => {
        const { closed } = await turnoConAjustePendiente(950);

        expect(closed.cashDifference).toBeCloseTo(-50, 2);
        expect(closed.hasPendingAdjustment).toBe(true);
        expect(closed.adjustmentStatus).toBe('pending');
    });

    it('un sobrante también lo deja pendiente: el sentido de la diferencia da igual', async () => {
        const { closed } = await turnoConAjustePendiente(1050);

        expect(closed.cashDifference).toBeCloseTo(50, 2);
        expect(closed.hasPendingAdjustment).toBe(true);
        expect(closed.adjustmentStatus).toBe('pending');
    });

    it('un centavo de diferencia ya cuenta como ajuste', async () => {
        const session = await abrirTurno(1000);
        const closed = await cerrarTurno(session.id, session.openedBy, 1000.01);

        expect(closed!.hasPendingAdjustment).toBe(true);
        expect(closed!.adjustmentStatus).toBe('pending');
    });

    /**
     * Frontera de coma flotante: `500.01 - 500` vale 0.009999999999990905 en
     * IEEE-754, así que la comparación cruda `>= 0.01` daba **false** y un
     * centavo de faltante real cerraba el turno como cuadrado, sin ajuste que
     * revisar. El cálculo redondea a centavos antes de comparar.
     */
    it('el centavo de faltante no se pierde en la coma flotante', async () => {
        expect(500.01 - 500).toBeLessThan(0.01); // el error que motivó el fix

        const session = await abrirTurno(500);
        const closed = await cerrarTurno(session.id, session.openedBy, 500.01);

        expect(closed!.cashDifference).toBe(0.01);
        expect(closed!.hasPendingAdjustment).toBe(true);
        expect(closed!.adjustmentStatus).toBe('pending');
    });

    it('la diferencia se guarda en centavos limpios, no en 39.999999999', async () => {
        const session = await abrirTurno(1000.1);
        const closed = await cerrarTurno(session.id, session.openedBy, 960.2);

        expect(closed!.cashDifference).toBe(-39.9);
    });

    it('un corte que cuadra no molesta a nadie', async () => {
        const session = await abrirTurno(1000);
        const closed = await cerrarTurno(session.id, session.openedBy, 1000);

        expect(closed!.cashDifference).toBe(0);
        expect(closed!.hasPendingAdjustment).toBe(false);
        expect(closed!.adjustmentStatus).toBeNull();
    });

    it('por debajo del centavo la diferencia es ruido de redondeo, no ajuste', async () => {
        const session = await abrirTurno(1000);
        const closed = await cerrarTurno(session.id, session.openedBy, 1000.005);

        expect(closed!.hasPendingAdjustment).toBe(false);
        expect(closed!.adjustmentStatus).toBeNull();
    });

    it('el cierre automático por expiración NUNCA deja ajuste pendiente', async () => {
        const session = await abrirTurno(1000);
        const closed = await cerrarTurno(session.id, session.openedBy, 700, {
            autoClosedByExpiry: true,
        });

        // La diferencia se conserva —el reporte Z la sigue mostrando—, pero no
        // hay a quién pedirle explicación a las 24:00.
        expect(closed!.cashDifference).toBeCloseTo(-300, 2);
        expect(closed!.autoClosedByExpiry).toBe(true);
        expect(closed!.hasPendingAdjustment).toBe(false);
        expect(closed!.adjustmentStatus).toBeNull();
    });

    it('sin la marca de expiración el cierre es manual y sí genera ajuste', async () => {
        const session = await abrirTurno(1000);
        const closed = await cerrarTurno(session.id, session.openedBy, 700);

        expect(closed!.autoClosedByExpiry).toBe(false);
        expect(closed!.hasPendingAdjustment).toBe(true);
    });

    it('deja la diferencia en la bitácora aunque el cierre haya sido automático', async () => {
        const crearAuditLog = jest.spyOn(auditRepo, 'createAuditLog');
        const session = await abrirTurno(1000);
        await cerrarTurno(session.id, session.openedBy, 700, { autoClosedByExpiry: true });

        const registro = crearAuditLog.mock.calls
            .map(([payload]) => payload)
            .find((payload) => payload.entityId === session.id);
        expect(registro?.action).toBe('cash_session.closed_with_difference');
        expect(registro?.metadata?.autoClosedByExpiry).toBe(true);
        crearAuditLog.mockRestore();
    });

    it('no audita un corte que cuadra', async () => {
        const crearAuditLog = jest.spyOn(auditRepo, 'createAuditLog');
        const session = await abrirTurno(1000);
        await cerrarTurno(session.id, session.openedBy, 1000);

        expect(
            crearAuditLog.mock.calls.some(([payload]) => payload.entityId === session.id),
        ).toBe(false);
        crearAuditLog.mockRestore();
    });

    it('no se cierra dos veces', async () => {
        const { session } = await turnoConAjustePendiente();

        await expect(
            cashSessionsService.closeSession(session.id, session.openedBy, 'cashier', 100),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('un turno inexistente no se cierra', async () => {
        await expect(
            cashSessionsService.closeSession('no-existe', 'u1', 'admin', 100),
        ).rejects.toBeInstanceOf(AppError);
    });
});

describe('cash-sessions.service - reviewAdjustment', () => {
    it('aprueba el ajuste y deja constancia de quién y cuándo', async () => {
        const { session } = await turnoConAjustePendiente();

        const revisado = await cashSessionsService.reviewAdjustment(
            session.id,
            'admin-1',
            'approved',
            '  Se depositó el faltante  ',
        );

        expect(revisado.adjustmentStatus).toBe('approved');
        expect(revisado.adjustmentReviewedBy).toBe('admin-1');
        expect(revisado.adjustmentReviewedAt).toBeTruthy();
        expect(revisado.adjustmentNote).toBe('Se depositó el faltante');
        // El turno sale de la bandeja de pendientes.
        expect(revisado.hasPendingAdjustment).toBe(false);
    });

    it('rechaza el ajuste con la misma constancia', async () => {
        const { session } = await turnoConAjustePendiente(1200);

        const revisado = await cashSessionsService.reviewAdjustment(
            session.id,
            'admin-2',
            'rejected',
            'No coincide con el arqueo',
        );

        expect(revisado.adjustmentStatus).toBe('rejected');
        expect(revisado.adjustmentReviewedBy).toBe('admin-2');
        expect(revisado.hasPendingAdjustment).toBe(false);
    });

    it('la nota es opcional: sin ella queda en null, no en cadena vacía', async () => {
        const { session } = await turnoConAjustePendiente();

        const revisado = await cashSessionsService.reviewAdjustment(
            session.id,
            'admin-1',
            'approved',
        );

        expect(revisado.adjustmentNote).toBeNull();
    });

    it('una nota en blanco tampoco se guarda como texto', async () => {
        const { session } = await turnoConAjustePendiente();

        const revisado = await cashSessionsService.reviewAdjustment(
            session.id,
            'admin-1',
            'approved',
            '   ',
        );

        expect(revisado.adjustmentNote).toBeNull();
    });

    it('escribe la revisión en la bitácora', async () => {
        const crearAuditLog = jest.spyOn(auditRepo, 'createAuditLog');
        const { session } = await turnoConAjustePendiente();

        await cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'approved', 'ok');

        const registro = crearAuditLog.mock.calls
            .map(([payload]) => payload)
            .find(
                (payload) =>
                    payload.entityId === session.id &&
                    payload.action === 'cash_session.adjustment_reviewed',
            );
        expect(registro).toBeDefined();
        expect(registro?.userId).toBe('admin-1');
        expect(registro?.metadata?.decision).toBe('approved');
        crearAuditLog.mockRestore();
    });

    it('no se puede aprobar dos veces: el rastro del faltante no se reescribe', async () => {
        const { session } = await turnoConAjustePendiente();
        await cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'approved');

        await expect(
            cashSessionsService.reviewAdjustment(session.id, 'admin-2', 'approved'),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('un ajuste rechazado tampoco se puede volver a revisar', async () => {
        const { session } = await turnoConAjustePendiente();
        await cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'rejected');

        await expect(
            cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'approved'),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('un turno que cerró cuadrado no tiene nada que revisar', async () => {
        const session = await abrirTurno(1000);
        await cerrarTurno(session.id, session.openedBy, 1000);

        await expect(
            cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'approved'),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('un turno todavía abierto no tiene ajuste que revisar', async () => {
        const session = await abrirTurno(1000);

        await expect(
            cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'approved'),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('un cierre automático con diferencia queda fuera de la revisión', async () => {
        const session = await abrirTurno(1000);
        await cerrarTurno(session.id, session.openedBy, 500, { autoClosedByExpiry: true });

        await expect(
            cashSessionsService.reviewAdjustment(session.id, 'admin-1', 'approved'),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('un turno inexistente no se revisa', async () => {
        await expect(
            cashSessionsService.reviewAdjustment('no-existe', 'admin-1', 'approved'),
        ).rejects.toBeInstanceOf(AppError);
    });
});

describe('cash-sessions.service - addMovement', () => {
    it('guarda el rubro y la descripción del gasto', async () => {
        const session = await abrirTurno();

        const movimiento = await cashSessionsService.addMovement(
            session.id,
            session.openedBy,
            'cashier',
            {
                type: 'expense',
                amount: 250,
                reason: '  Garrafones  ',
                category: 'supplies',
                description: '  4 garrafones de 20L  ',
            },
        );

        expect(movimiento.type).toBe('expense');
        expect(movimiento.category).toBe('supplies');
        expect(movimiento.description).toBe('4 garrafones de 20L');
        expect(movimiento.reason).toBe('Garrafones');

        const guardados = await cashMovementsRepo.listMovementsForSession(session.id);
        expect(guardados).toHaveLength(1);
        expect(guardados[0].category).toBe('supplies');
        expect(guardados[0].description).toBe('4 garrafones de 20L');
    });

    it('un depósito se guarda sin rubro ni descripción', async () => {
        const session = await abrirTurno();

        const movimiento = await cashSessionsService.addMovement(
            session.id,
            session.openedBy,
            'cashier',
            { type: 'deposit', amount: 500, reason: 'Fondo adicional' },
        );

        expect(movimiento.category).toBeNull();
        expect(movimiento.description).toBeNull();
    });

    it('una descripción en blanco no se guarda como cadena vacía', async () => {
        const session = await abrirTurno();

        const movimiento = await cashSessionsService.addMovement(
            session.id,
            session.openedBy,
            'cashier',
            {
                type: 'expense',
                amount: 100,
                reason: 'Luz',
                category: 'electricity',
                description: '   ',
            },
        );

        expect(movimiento.description).toBeNull();
    });

    it('el gasto sale del cajón y baja el efectivo esperado del corte', async () => {
        const session = await abrirTurno(1000);
        await cashSessionsService.addMovement(session.id, session.openedBy, 'cashier', {
            type: 'expense',
            amount: 250,
            reason: 'Renta',
            category: 'rent',
        });

        // Con el gasto descontado, contar 750 cuadra el turno.
        const closed = await cerrarTurno(session.id, session.openedBy, 750);
        expect(closed!.expectedCashAmount).toBeCloseTo(750, 2);
        expect(closed!.hasPendingAdjustment).toBe(false);
    });

    it('no acepta movimientos sobre un turno ya cerrado', async () => {
        const { session } = await turnoConAjustePendiente();

        await expect(
            cashSessionsService.addMovement(session.id, session.openedBy, 'cashier', {
                type: 'expense',
                amount: 10,
                reason: 'Tarde',
                category: 'other',
                description: 'x',
            }),
        ).rejects.toBeInstanceOf(AppError);
    });

    it('el turno es de quien lo abrió: otro cajero no le carga gastos', async () => {
        const session = await abrirTurno();

        await expect(
            cashSessionsService.addMovement(session.id, 'otro-cajero', 'cashier', {
                type: 'expense',
                amount: 10,
                reason: 'Ajeno',
                category: 'food',
            }),
        ).rejects.toBeInstanceOf(AppError);
    });
});

describe('cash-sessions.service - auditoría global', () => {
    it('listAllMovements filtra por turno, tipo y rubro', async () => {
        const session = await abrirTurno();
        const alta = (
            input: Parameters<typeof cashSessionsService.addMovement>[3],
        ) => cashSessionsService.addMovement(session.id, session.openedBy, 'cashier', input);

        await alta({ type: 'deposit', amount: 100, reason: 'Fondo' });
        await alta({ type: 'expense', amount: 200, reason: 'Renta', category: 'rent' });
        await alta({
            type: 'expense',
            amount: 300,
            reason: 'Insumos',
            category: 'supplies',
            description: 'Bolsas',
        });

        const todos = await cashSessionsService.listAllMovements({ cashSessionId: session.id });
        expect(todos.items).toHaveLength(3);
        expect(todos.meta.total).toBe(3);

        const gastos = await cashSessionsService.listAllMovements({
            cashSessionId: session.id,
            type: 'expense',
        });
        expect(gastos.items).toHaveLength(2);

        const insumos = await cashSessionsService.listAllMovements({
            cashSessionId: session.id,
            type: 'expense',
            category: 'supplies',
        });
        expect(insumos.items).toHaveLength(1);
        expect(insumos.items[0].amount).toBe(300);
    });

    /**
     * El `meta` tiene que contar lo que quedó DESPUÉS de los filtros que se
     * aplican en memoria: si contara el lote leído de Firestore, la tabla
     * ofrecería páginas que no existen.
     */
    it('listAllMovements pagina y el total es el del filtro aplicado', async () => {
        const session = await abrirTurno();
        const alta = (
            input: Parameters<typeof cashSessionsService.addMovement>[3],
        ) => cashSessionsService.addMovement(session.id, session.openedBy, 'cashier', input);

        await alta({ type: 'deposit', amount: 100, reason: 'Fondo' });
        await alta({ type: 'expense', amount: 200, reason: 'Renta', category: 'rent' });
        await alta({ type: 'expense', amount: 300, reason: 'Luz', category: 'electricity' });

        const primera = await cashSessionsService.listAllMovements({
            cashSessionId: session.id,
            type: 'expense',
            page: 1,
            limit: 1,
        });
        expect(primera.items).toHaveLength(1);
        expect(primera.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });

        const segunda = await cashSessionsService.listAllMovements({
            cashSessionId: session.id,
            type: 'expense',
            page: 2,
            limit: 1,
        });
        expect(segunda.items).toHaveLength(1);
        expect(segunda.items[0].id).not.toBe(primera.items[0].id);

        // Página más allá del final: vacía, pero con el total real para que la
        // tabla pueda reencuadrar en vez de quedarse en blanco.
        const tercera = await cashSessionsService.listAllMovements({
            cashSessionId: session.id,
            type: 'expense',
            page: 3,
            limit: 1,
        });
        expect(tercera.items).toHaveLength(0);
        expect(tercera.meta.total).toBe(2);
    });

    it('listCashSessions encuentra los turnos del cajero por estado del ajuste', async () => {
        const cajero = unique('cajero');
        const from = new Date(Date.now() - 60_000).toISOString();

        const conAjuste = await abrirTurno(1000, cajero);
        await cerrarTurno(conAjuste.id, cajero, 900);
        const cuadrado = await abrirTurno(1000, cajero);
        await cerrarTurno(cuadrado.id, cajero, 1000);

        const pendientes = await cashSessionsService.listCashSessions({
            from,
            openedBy: cajero,
            adjustmentStatus: 'pending',
        });

        expect(pendientes.items.map((session) => session.id)).toEqual([conAjuste.id]);
        expect(pendientes.meta.total).toBe(1);
    });

    it('listCashSessions sin filtros trae los turnos más recientes primero', async () => {
        const cajero = unique('cajero');
        const from = new Date(Date.now() - 60_000).toISOString();

        const primero = await abrirTurno(0, cajero);
        // `now()` tiene precisión de milisegundo: sin esta pausa dos turnos
        // seguidos pueden compartir `openedAt` y el orden queda indefinido.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const segundo = await abrirTurno(0, cajero);

        const sesiones = await cashSessionsService.listCashSessions({ from, openedBy: cajero });
        expect(sesiones.items.map((session) => session.id)).toEqual([segundo.id, primero.id]);
    });
});
