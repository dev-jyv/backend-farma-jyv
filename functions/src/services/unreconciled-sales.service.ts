import { createHash } from 'crypto';
import {
    Sale,
    UnreconciledSale,
    UnreconciledSaleListItem,
    UnreconciledSaleResolution,
} from '../types';
import { buildListMeta, ListMeta, parsePagination } from '../utils/pagination';
import { toTimestamp } from '../utils/firestore';
import { AppError, badRequest, conflict, notFound } from '../utils/errors';
import { unreconciledSalePayloadSchema } from '../schemas/sales';
import * as unreconciledRepo from '../repositories/unreconciled-sales.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as usersRepo from '../repositories/users.repository';
import * as diagnosticsRepo from '../repositories/pos-diagnostics.repository';
import { recordAudit, writeAuditInTransaction } from './audit.service';
import { createSale } from './sales.service';

/**
 * Ventas cobradas en la caja que el servidor no pudo registrar como venta.
 *
 * El dinero ya entró y el ticket ya se imprimió, así que el movimiento no puede
 * perderse; pero meterlas en `sales` a la fuerza descuadraría el inventario —el
 * rechazo suele ser justamente que el producto no existe en el servidor—. Quedan
 * aquí, auditadas, hasta que alguien las resuelva desde el panel (SPEC 53):
 * registrarlas como venta o descartarlas con motivo.
 */

/**
 * Tope de espera del correo de venta no conciliada dentro del alta. Se espera
 * (en Cloud Functions lo que sigue después de responder no tiene CPU
 * garantizada), pero acotado: la caja no debe quedarse colgada porque Resend
 * tarde. Mismo criterio que SPEC 44.
 */
export const UNRECONCILED_SALE_ALERT_TIMEOUT_MS = 5_000;

/**
 * Avisa por correo **sin poder fallar**: cualquier error (Resend caído, variable
 * sin configurar, la propia carga del módulo) queda en el log. La cadena de
 * correo se importa aquí dentro para no cargarla en el arranque en frío de `api`.
 */
const notifyUnreconciledSale = async (sale: UnreconciledSale): Promise<void> => {
    const send = (async () => {
        const { sendUnreconciledSaleAlert } = await import(
            './unreconciled-sales-alert-sender.service'
        );
        await sendUnreconciledSaleAlert(sale);
    })().catch((error: unknown) => {
        console.error('No se pudo mandar la alerta de venta no conciliada', {
            id: sale.id,
            error: error instanceof Error ? error.message : String(error),
        });
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            console.warn('La alerta de venta no conciliada tardó más del tope; se responde igual', {
                id: sale.id,
            });
            resolve();
        }, UNRECONCILED_SALE_ALERT_TIMEOUT_MS);
    });
    try {
        await Promise.race([send, timeout]);
    } finally {
        clearTimeout(timer);
    }
};

export const recordUnreconciledSale = async (input: {
    localId: string;
    deviceId?: string;
    localFolio?: string;
    reason: string;
    total: number;
    occurredAt?: string;
    cashSessionId?: string;
    payload: Record<string, unknown>;
    cashierId: string;
    roleSlug?: string | null;
}): Promise<UnreconciledSale> => {
    const { sale, created } = await unreconciledRepo.saveUnreconciledSale({
        localId: input.localId,
        deviceId: input.deviceId ?? null,
        localFolio: input.localFolio ?? null,
        reason: input.reason,
        total: input.total,
        payload: input.payload,
        cashierId: input.cashierId,
        cashSessionId: input.cashSessionId ?? null,
        occurredAt: input.occurredAt ? toTimestamp(input.occurredAt) : null,
    });

    // Un reenvío de la misma venta no repite bitácora ni correo.
    if (!created) {
        return sale;
    }

    await recordAudit({
        action: 'sale.unreconciled',
        entity: 'unreconciledSale',
        entityId: sale.id,
        summary: `Venta cobrada en caja por ${input.total.toFixed(2)} ` +
            `sin registrar: ${input.reason}`,
        userId: input.cashierId,
        roleSlug: input.roleSlug ?? null,
        metadata: {
            localId: input.localId,
            deviceId: input.deviceId ?? null,
            localFolio: input.localFolio ?? null,
            reason: input.reason,
            total: input.total,
        },
    });
    await notifyUnreconciledSale(sale);

    return sale;
};

/**
 * Nombres de cajero y caja para el listado. El perfil sale de la caché del guard
 * (60 s) y las cajas en una sola lectura con máscara. Son cortesía: si fallan,
 * quedan en `null` y el listado sale igual.
 */
const attachNames = async (sales: UnreconciledSale[]): Promise<UnreconciledSaleListItem[]> => {
    const cashierIds = [...new Set(sales.map((sale) => sale.cashierId).filter(Boolean))];
    const [cashierEntries, deviceNames] = await Promise.all([
        Promise.all(cashierIds.map(async (uid) => {
            const profile = await usersRepo.getUserProfile(uid).catch(() => null);
            const name = profile?.displayName?.trim() || profile?.email?.trim() || null;
            return [uid, name] as const;
        })),
        diagnosticsRepo
            .getDeviceNames(sales.flatMap((sale) => (sale.deviceId ? [sale.deviceId] : [])))
            .catch(() => new Map<string, string>()),
    ]);
    const cashierNames = new Map(cashierEntries);
    return sales.map((sale) => ({
        ...sale,
        cashierName: cashierNames.get(sale.cashierId) ?? null,
        deviceName: sale.deviceId ? deviceNames.get(sale.deviceId) ?? null : null,
    }));
};

export const listUnreconciledSales = async (filters: {
    from?: string;
    to?: string;
    includeResolved?: boolean;
    page?: number;
    limit?: number;
}): Promise<{ items: UnreconciledSaleListItem[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items, total } = await unreconciledRepo.listUnreconciledSales({
        ...filters,
        page,
        limit,
    });
    return { items: await attachNames(items), meta: buildListMeta(page, limit, total) };
};

export interface ResolveUnreconciledSaleResult {
    unreconciled: UnreconciledSale;
    sale?: Sale;
}

const ACTION_LABELS: Record<UnreconciledSaleResolution, string> = {
    register: 'registrada como venta',
    discard: 'descartada',
};

/**
 * Llave de respaldo para un payload sin `idempotencyKey` (POS muy viejo):
 * derivada del id del documento, así dos clics en "Registrar" no crean dos
 * ventas.
 */
const fallbackIdempotencyKey = (id: string): string =>
    `unreconciled-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;

/**
 * Registra la venta con el payload guardado. Es una venta **offline** (ya se
 * cobró): sigue las reglas de `/sales/bulk`, incluida la política de SPEC 52
 * cuando exista. El cajero es el que la cobró —la llave de idempotencia es
 * suya—, y el rol es el de quien la resuelve, que es quien la autoriza.
 *
 * Si `createSale` la rechaza (el producto sigue sin existir), el error sale tal
 * cual (400 con el motivo) y la venta sigue pendiente.
 */
const registerFromPayload = async (
    unreconciled: UnreconciledSale,
    roleSlug: string | undefined,
): Promise<Sale> => {
    const parsed = unreconciledSalePayloadSchema.safeParse(unreconciled.payload);
    if (!parsed.success) {
        const detail = parsed.error.errors
            .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
            .join('; ');
        throw badRequest(`La venta guardada no se puede registrar tal cual: ${detail}`);
    }
    const payload = parsed.data;
    const occurredAt = unreconciled.occurredAt?.toDate().toISOString();

    try {
        return await createSale({
            ...payload,
            idempotencyKey: payload.idempotencyKey ?? fallbackIdempotencyKey(unreconciled.id),
            // El turno del payload si lo trae; si no, el que reportó la caja; si
            // tampoco, la venta entra sin turno.
            cashSessionId: payload.cashSessionId ?? unreconciled.cashSessionId ?? null,
            soldAt: payload.soldAt ?? occurredAt,
            cashierId: unreconciled.cashierId,
            roleSlug,
            offline: true,
            // Quien resuelve responde por la hora de cobro: el turno pudo nacer
            // en el servidor después de la venta (ver `createSale`).
            soldAtBeforeSessionAuthorized: true,
        });
    } catch (error) {
        throw asRegisterRejection(error);
    }
};

/**
 * Un 404 de `createSale` (producto o turno que no existe) aquí no significa que
 * falte la venta no conciliada, que sí existe: sale como 400 con el mismo
 * motivo, y la venta sigue pendiente (SPEC 53).
 */
const asRegisterRejection = (error: unknown): unknown => {
    if (!(error instanceof AppError) || error.statusCode !== 404) {
        return error;
    }
    const rejection = new AppError(
        400,
        'BAD_REQUEST',
        `No se pudo registrar la venta: ${error.message}`,
        { syncCode: error.syncCode, details: error.details },
    );
    rejection.stack = error.stack;
    return rejection;
};

/**
 * `POST /sales/unreconciled/:id/resolve` (SPEC 53).
 *
 * - `register`: crea la venta con el payload guardado y guarda `resolvedSaleId`.
 * - `discard`: la deja marcada con el motivo.
 *
 * Las dos se auditan (`sale.unreconciled_resolved`) en la misma transacción que
 * la marca. Repetir la misma acción sobre una ya resuelta (doble clic) devuelve
 * el resultado existente; pedir la contraria es 409.
 */
export const resolveUnreconciledSale = async (
    id: string,
    input: { action: UnreconciledSaleResolution; reason?: string },
    actor: { userId: string; roleSlug?: string },
): Promise<ResolveUnreconciledSaleResult> => {
    const unreconciled = await unreconciledRepo.getUnreconciledSaleById(id);
    if (!unreconciled) {
        throw notFound('Venta no conciliada');
    }
    if (unreconciled.resolvedAt) {
        return answerAlreadyResolved(unreconciled, input.action);
    }

    const reason = input.reason?.trim() || null;
    const sale = input.action === 'register'
        ? await registerFromPayload(unreconciled, actor.roleSlug)
        : undefined;

    const outcome = await unreconciledRepo.markUnreconciledSaleResolved(
        id,
        {
            action: input.action,
            reason,
            resolvedBy: actor.userId,
            resolvedSaleId: sale?.id ?? null,
        },
        (transaction, resolved) => writeAuditInTransaction(transaction, {
            action: 'sale.unreconciled_resolved',
            entity: 'unreconciledSale',
            entityId: id,
            summary: `Venta no conciliada por ${resolved.total.toFixed(2)} ` +
                `${ACTION_LABELS[input.action]}` +
                (sale ? ` (folio ${sale.folio})` : '') +
                (reason ? `: ${reason}` : ''),
            userId: actor.userId,
            roleSlug: actor.roleSlug ?? null,
            metadata: {
                action: input.action,
                reason,
                localId: resolved.localId,
                deviceId: resolved.deviceId,
                cashierId: resolved.cashierId,
                total: resolved.total,
                resolvedSaleId: sale?.id ?? null,
                // Fecha con la que quedó: quien resolvió autorizó la hora de cobro.
                saleBusinessAt: sale?.businessAt?.toDate().toISOString() ?? null,
                lateSync: sale?.lateSync === true,
            },
        }),
    );

    if (outcome.status === 'not_found') {
        throw notFound('Venta no conciliada');
    }
    if (outcome.status === 'already_resolved') {
        // Otro clic la resolvió mientras se registraba. `createSale` es idempotente
        // con la llave del payload, así que la venta es la misma, no otra.
        return answerAlreadyResolved(outcome.sale, input.action, sale);
    }
    return { unreconciled: outcome.sale, ...(sale ? { sale } : {}) };
};

const answerAlreadyResolved = async (
    unreconciled: UnreconciledSale,
    action: UnreconciledSaleResolution,
    sale?: Sale,
): Promise<ResolveUnreconciledSaleResult> => {
    // Las resueltas antes de SPEC 53 no guardan acción: cualquier intento es 409.
    if (unreconciled.resolution !== action) {
        throw conflict(
            unreconciled.resolution
                ? `La venta no conciliada ya fue ${ACTION_LABELS[unreconciled.resolution]}`
                : 'La venta no conciliada ya se marcó como atendida',
        );
    }
    if (sale) {
        return { unreconciled, sale };
    }
    const existing = unreconciled.resolvedSaleId
        ? await salesRepo.getSaleById(unreconciled.resolvedSaleId)
        : null;
    return { unreconciled, ...(existing ? { sale: existing } : {}) };
};
