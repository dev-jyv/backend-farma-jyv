import { createHash } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
    ControlledGroup,
    RefundMethod,
    Sale,
    SaleProductItem,
    SaleReturn,
    SaleReturnItem,
    isSaleProductItem,
    isSaleServiceItem,
} from '../types';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { db, now } from '../utils/firestore';
import { breakdownWithRates, fromCents, sumTaxSummary, toCents } from '../utils/taxes';
import * as salesRepo from '../repositories/sales.repository';
import * as returnsRepo from '../repositories/sale-returns.repository';
import * as cashSessionsRepo from '../repositories/cash-sessions.repository';
import * as mercadoPagoService from './mercado-pago.service';
import { writeLedgerEntryInTransaction } from './controlled.service';
import { getControlledRule } from '../constants/controlled';
import { recordAudit } from './audit.service';
import { assertCanAccessSession } from './cash-sessions.service';

const RETURNS_COUNTER_ID = 'saleReturns';
const IDEMPOTENCY_COLLECTION = 'saleIdempotencyKeys';
const IDEMPOTENCY_TTL_HOURS = 48;

const buildFolio = (sequence: number): string => `D-${String(sequence).padStart(6, '0')}`;

/** Devolver dinero y stock no es tarea de cajero raso. */
export const assertCanReturnSale = (roleSlug: string): void => {
    if (roleSlug !== 'admin' && roleSlug !== 'manager') {
        throw forbidden('Solo un administrador o gerente puede registrar devoluciones');
    }
};

export interface SaleReturnItemInput {
    productId: string;
    quantity: number;
}

/**
 * Huella estable de la devolución: misma venta + mismas cantidades + mismo método.
 * Sirve para dos cosas — nuestra propia idempotencia y la llave de idempotencia que
 * se manda a Mercado Pago, para que un retry no reembolse dos veces.
 */
const buildReturnFingerprint = (input: {
    saleId: string;
    items: SaleReturnItemInput[];
    refundMethod: RefundMethod;
}): string => createHash('sha256')
    .update(JSON.stringify({
        saleId: input.saleId,
        items: [...input.items]
            .map((item) => ({ productId: item.productId, quantity: item.quantity }))
            .sort((a, b) => a.productId.localeCompare(b.productId)),
        refundMethod: input.refundMethod,
    }))
    .digest('hex');

/**
 * Método de reembolso por omisión: el mismo por el que entró el dinero. En pago
 * mixto no hay respuesta única (parte efectivo, parte tarjeta), así que se exige
 * que el cajero lo indique.
 */
const resolveRefundMethod = (
    sale: Sale,
    requested?: RefundMethod,
): RefundMethod => {
    if (requested) {
        if (requested === 'card' && !sale.pointPayment && !sale.cardPaymentReference) {
            throw badRequest('La venta no tiene un pago con tarjeta que reembolsar');
        }
        return requested;
    }
    if (sale.paymentMethod === 'mixed') {
        throw badRequest(
            'La venta se pagó de forma mixta: indica el método de reembolso',
        );
    }
    return sale.paymentMethod;
};

/**
 * Reparte la cantidad devuelta entre los lotes de los que salió originalmente,
 * descontando lo que ya se devolvió en devoluciones previas. Devolver a un lote
 * distinto rompería la trazabilidad de caducidad (el lote es la unidad FEFO).
 */
const planAllocations = (
    saleItem: SaleProductItem,
    quantity: number,
    alreadyReturnedByBatch: Map<string, number>,
): Array<{ batchId: string; quantity: number }> => {
    const plan: Array<{ batchId: string; quantity: number }> = [];
    let pending = quantity;

    for (const allocation of saleItem.batchAllocations) {
        if (pending <= 0) {
            break;
        }
        const key = `${saleItem.productId}:${allocation.batchId}`;
        const returned = alreadyReturnedByBatch.get(key) ?? 0;
        const available = allocation.quantity - returned;
        if (available <= 0) {
            continue;
        }
        const take = Math.min(available, pending);
        plan.push({ batchId: allocation.batchId, quantity: take });
        alreadyReturnedByBatch.set(key, returned + take);
        pending -= take;
    }

    if (pending > 0) {
        throw badRequest(
            `No hay lotes de origen suficientes para devolver ${saleItem.productName}`,
        );
    }
    return plan;
};

export const createSaleReturn = async (input: {
    saleId: string;
    items: SaleReturnItemInput[];
    reason: string;
    refundMethod?: RefundMethod;
    cashSessionId: string;
    userId: string;
    roleSlug: string;
    idempotencyKey?: string;
}): Promise<SaleReturn> => {
    assertCanReturnSale(input.roleSlug);

    if (!input.items.length) {
        throw badRequest('La devolución debe tener al menos un producto');
    }

    const sale = await salesRepo.getSaleById(input.saleId);
    if (!sale) {
        throw notFound('Venta');
    }
    if (sale.voidedAt) {
        throw badRequest('La venta está anulada');
    }

    const refundMethod = resolveRefundMethod(sale, input.refundMethod);
    const fingerprint = buildReturnFingerprint({
        saleId: input.saleId,
        items: input.items,
        refundMethod,
    });

    const firestore = db();
    const idempotencyRef = input.idempotencyKey
        ? firestore
            .collection(IDEMPOTENCY_COLLECTION)
            .doc(`${input.userId}:return:${input.idempotencyKey}`)
        : null;

    if (idempotencyRef) {
        const idemDoc = await idempotencyRef.get();
        if (idemDoc.exists) {
            const stored = idemDoc.data()!;
            if (stored.requestFingerprint !== fingerprint) {
                throw conflict(
                    'Esta llave de idempotencia ya se usó para una devolución distinta',
                );
            }
            const existing = await returnsRepo.getSaleReturnById(stored.saleReturnId as string);
            if (!existing) {
                throw conflict(
                    'La llave de idempotencia apunta a una devolución que ya no existe',
                );
            }
            return existing;
        }
    }

    const session = await cashSessionsRepo.getCashSessionById(input.cashSessionId);
    if (!session) {
        throw notFound('Turno de caja');
    }
    // Misma regla que en la venta: el reembolso en efectivo sale del cajón de este
    // turno, así que no puede cargarse al turno de otro cajero.
    assertCanAccessSession(session, input.userId, input.roleSlug);
    if (session.closedAt) {
        throw badRequest('El turno de caja ya está cerrado');
    }

    const previousReturns = await returnsRepo.listReturnsForSale(input.saleId);
    const returnedQtyByProduct = new Map<string, number>();
    const returnedByBatch = new Map<string, number>();
    const refundedCentsByProduct = new Map<string, number>();

    for (const previous of previousReturns) {
        for (const item of previous.items) {
            returnedQtyByProduct.set(
                item.productId,
                (returnedQtyByProduct.get(item.productId) ?? 0) + item.quantity,
            );
            refundedCentsByProduct.set(
                item.productId,
                (refundedCentsByProduct.get(item.productId) ?? 0) + toCents(item.refundAmount),
            );
            for (const allocation of item.batchAllocations) {
                const key = `${item.productId}:${allocation.batchId}`;
                returnedByBatch.set(
                    key,
                    (returnedByBatch.get(key) ?? 0) + allocation.quantity,
                );
            }
        }
    }

    const soldByProduct = new Map<string, SaleProductItem>();
    // Ids de servicio de la venta: se guardan para poder rechazar la devolución
    // con un motivo claro en vez de un "no forma parte de la venta" que miente.
    const soldServiceIds = new Set(
        sale.items.filter(isSaleServiceItem).map((item) => item.serviceId),
    );
    for (const item of sale.items) {
        if (!isSaleProductItem(item)) {
            continue;
        }
        const existing = soldByProduct.get(item.productId);
        if (existing) {
            // Dos partidas del mismo producto: se consolidan para validar cantidades.
            soldByProduct.set(item.productId, {
                ...existing,
                quantity: existing.quantity + item.quantity,
                subtotal: existing.subtotal + item.subtotal,
                discountAmount: existing.discountAmount + item.discountAmount,
                netAmount: (existing.netAmount ?? 0) + (item.netAmount ?? 0),
                batchAllocations: [...existing.batchAllocations, ...item.batchAllocations],
            });
        } else {
            soldByProduct.set(item.productId, item);
        }
    }

    const planned: SaleReturnItem[] = [];
    const seen = new Set<string>();

    for (const requested of input.items) {
        if (seen.has(requested.productId)) {
            throw badRequest(
                `El producto ${requested.productId} aparece dos veces en la devolución`,
            );
        }
        seen.add(requested.productId);

        if (!Number.isInteger(requested.quantity) || requested.quantity <= 0) {
            throw badRequest('Cantidad inválida en un ítem de devolución');
        }

        if (soldServiceIds.has(requested.productId)) {
            throw badRequest(
                'Los servicios no se devuelven; anula la venta completa',
            );
        }

        const saleItem = soldByProduct.get(requested.productId);
        if (!saleItem) {
            throw badRequest(
                `El producto ${requested.productId} no forma parte de la venta`,
            );
        }
        if (saleItem.netAmount === undefined || !saleItem.taxes) {
            throw badRequest(
                'La venta es anterior al desglose de impuestos: anúlala en lugar de ' +
                'devolverla parcialmente',
            );
        }

        const alreadyReturned = returnedQtyByProduct.get(requested.productId) ?? 0;
        const remaining = saleItem.quantity - alreadyReturned;
        if (requested.quantity > remaining) {
            throw badRequest(
                `Solo quedan ${remaining} unidades por devolver de ${saleItem.productName}`,
            );
        }

        // Reembolso proporcional a lo cobrado. Cuando se devuelve el resto de la
        // partida se paga el remanente exacto, así ningún centavo se queda dentro.
        const netCents = toCents(saleItem.netAmount);
        const refundedCents = refundedCentsByProduct.get(requested.productId) ?? 0;
        const refundCents = requested.quantity === remaining
            ? netCents - refundedCents
            : Math.round((netCents * requested.quantity) / saleItem.quantity);
        const refundAmount = fromCents(refundCents);

        planned.push({
            productId: saleItem.productId,
            productName: saleItem.productName,
            quantity: requested.quantity,
            unitPrice: saleItem.unitPrice,
            refundAmount,
            // Las tasas se toman de la venta, no del catálogo actual.
            taxes: breakdownWithRates({
                grossAmount: refundAmount,
                ivaRate: saleItem.taxes.ivaRate,
                iepsRate: saleItem.taxes.iepsRate,
            }),
            batchAllocations: planAllocations(saleItem, requested.quantity, returnedByBatch),
        });
    }

    const refundTotal = fromCents(
        planned.reduce((sum, item) => sum + toCents(item.refundAmount), 0),
    );
    if (refundTotal <= 0) {
        throw badRequest('El importe a devolver debe ser mayor a cero');
    }
    const pendingRefundable = fromCents(toCents(sale.total) - toCents(sale.refundedTotal ?? 0));
    if (toCents(refundTotal) > toCents(pendingRefundable)) {
        throw conflict('El importe a devolver supera lo que queda por devolver de la venta');
    }

    const taxSummary = sumTaxSummary(planned.map((item) => item.taxes));

    // El dinero se devuelve ANTES de escribir: la llave de idempotencia que se manda
    // a Mercado Pago es la huella de esta devolución, así que si la transacción falla
    // y el cajero reintenta, MP no reembolsa dos veces.
    let pointRefund: SaleReturn['pointRefund'] = null;
    if (refundMethod === 'card') {
        const orderId = sale.pointPayment?.orderId ?? sale.cardPaymentReference;
        if (!orderId) {
            throw badRequest('La venta no tiene una order de Mercado Pago que reembolsar');
        }
        const order = await mercadoPagoService.refundOrder({
            orderId,
            paymentId: sale.pointPayment?.paymentId ?? undefined,
            amount: refundTotal,
            idempotencyKey: `refund:${fingerprint}`,
        });
        pointRefund = {
            orderId: order.id,
            status: order.status,
            amount: refundTotal,
        };
    }

    const timestamp = now();
    const returnRef = firestore.collection('saleReturns').doc();
    const saleRef = firestore.collection('sales').doc(sale.id);
    const counterRef = firestore.collection('counters').doc(RETURNS_COUNTER_ID);

    const batchQuantities = new Map<string, { productId: string; quantity: number }>();
    for (const item of planned) {
        for (const allocation of item.batchAllocations) {
            const existing = batchQuantities.get(allocation.batchId);
            if (existing) {
                existing.quantity += allocation.quantity;
            } else {
                batchQuantities.set(allocation.batchId, {
                    productId: item.productId,
                    quantity: allocation.quantity,
                });
            }
        }
    }
    const uniqueBatches = [...batchQuantities.entries()];

    const saleReturn = await firestore.runTransaction(async (transaction) => {
        // Todas las lecturas antes de cualquier escritura (requisito de Firestore).
        const idemDoc = idempotencyRef ? await transaction.get(idempotencyRef) : null;
        if (idemDoc?.exists) {
            const stored = idemDoc.data()!;
            const existingDoc = await transaction.get(
                firestore.collection('saleReturns').doc(stored.saleReturnId as string),
            );
            if (!existingDoc.exists) {
                throw conflict(
                    'La llave de idempotencia apunta a una devolución que ya no existe',
                );
            }
            return returnsRepo.mapSaleReturn(existingDoc.id, existingDoc.data()!);
        }

        const returnedProductIds = [...new Set(planned.map((item) => item.productId))];
        const [saleDoc, counterDoc, batchDocs, productDocs] = await Promise.all([
            transaction.get(saleRef),
            transaction.get(counterRef),
            Promise.all(uniqueBatches.map(([batchId]) =>
                transaction.get(firestore.collection('batches').doc(batchId)))),
            Promise.all(returnedProductIds.map((productId) =>
                transaction.get(firestore.collection('products').doc(productId)))),
        ]);

        const productGroupById = new Map<string, ControlledGroup | undefined>();
        returnedProductIds.forEach((productId, index) => {
            productGroupById.set(
                productId,
                productDocs[index].data()?.controlledGroup as ControlledGroup | undefined,
            );
        });

        if (!saleDoc.exists) {
            throw notFound('Venta');
        }
        const saleData = saleDoc.data()!;
        if (saleData.voidedAt) {
            throw badRequest('La venta está anulada');
        }
        // Relectura dentro de la transacción: dos devoluciones simultáneas no pueden
        // sumar más de lo cobrado.
        const refundedSoFar = toCents((saleData.refundedTotal as number | undefined) ?? 0);
        if (refundedSoFar + toCents(refundTotal) > toCents(saleData.total as number)) {
            throw conflict(
                'El importe a devolver supera lo que queda por devolver de la venta',
            );
        }

        const nextSequence = (counterDoc.data()?.value as number | undefined ?? 0) + 1;
        const folio = buildFolio(nextSequence);

        uniqueBatches.forEach(([batchId, entry], index) => {
            const batchDoc = batchDocs[index];
            if (!batchDoc.exists) {
                throw notFound(`Lote ${batchId}`);
            }
            transaction.update(batchDoc.ref, {
                quantity: (batchDoc.data()?.quantity as number) + entry.quantity,
                updatedAt: timestamp,
            });
        });

        for (const item of planned) {
            for (const allocation of item.batchAllocations) {
                transaction.set(firestore.collection('stockMovements').doc(), {
                    type: 'return_in',
                    productId: item.productId,
                    batchId: allocation.batchId,
                    quantity: allocation.quantity,
                    referenceId: returnRef.id,
                    userId: input.userId,
                    createdAt: timestamp,
                });
            }
        }

        const stockDeltaByProduct = new Map<string, number>();
        for (const item of planned) {
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + item.quantity,
            );
        }
        returnedProductIds.forEach((productId, index) => {
            const delta = stockDeltaByProduct.get(productId) ?? 0;
            const denorm = productDocs[index].data()?.totalStock;
            const baseline = typeof denorm === 'number' ? denorm : 0;
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: Math.max(0, baseline + delta),
                updatedAt: timestamp,
            });
        });

        transaction.set(counterRef, { value: nextSequence }, { merge: true });
        transaction.update(saleRef, {
            refundedTotal: FieldValue.increment(refundTotal),
        });

        const returnData = {
            folio,
            saleId: sale.id,
            saleFolio: sale.folio,
            items: planned,
            productIds: [...new Set(planned.map((item) => item.productId))],
            refundTotal,
            refundMethod,
            taxSummary,
            pointRefund,
            reason: input.reason.trim(),
            cashSessionId: input.cashSessionId,
            createdBy: input.userId,
            createdAt: timestamp,
        };

        if (idempotencyRef) {
            transaction.create(idempotencyRef, {
                saleReturnId: returnRef.id,
                folio,
                userId: input.userId,
                requestFingerprint: fingerprint,
                createdAt: timestamp,
                expiresAt: Timestamp.fromMillis(
                    timestamp.toMillis() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
                ),
            });
        }

        // Libro de control: el producto controlado que regresa se contra-asienta.
        for (const item of planned) {
            const rule = getControlledRule(productGroupById.get(item.productId));
            if (!rule?.requiresLedger) {
                continue;
            }
            writeLedgerEntryInTransaction(transaction, {
                type: 'return',
                saleId: sale.id,
                saleFolio: sale.folio,
                referenceFolio: folio,
                productId: item.productId,
                productName: item.productName,
                controlledGroup: rule.group,
                quantity: -item.quantity,
                lotNumbers: [],
                prescription: sale.prescription,
                prescriptionRetained: Boolean(sale.prescriptionRetained),
                customerName: sale.customerName,
                userId: input.userId,
                createdAt: timestamp,
            });
        }

        transaction.set(returnRef, returnData);
        return { id: returnRef.id, ...returnData } as SaleReturn;
    });

    await recordAudit({
        action: 'sale.returned',
        entity: 'saleReturn',
        entityId: saleReturn.id,
        summary: `Devolución ${saleReturn.folio} de la venta ${sale.folio} por ` +
            `${saleReturn.refundTotal.toFixed(2)} (${refundMethod})`,
        userId: input.userId,
        roleSlug: input.roleSlug,
        metadata: {
            folio: saleReturn.folio,
            saleFolio: sale.folio,
            refundTotal: saleReturn.refundTotal,
            refundMethod,
            reason: saleReturn.reason,
            items: saleReturn.items.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                refundAmount: item.refundAmount,
            })),
        },
    });

    return saleReturn;
};

export const getSaleReturn = async (id: string): Promise<SaleReturn> => {
    const saleReturn = await returnsRepo.getSaleReturnById(id);
    if (!saleReturn) {
        throw notFound('Devolución');
    }
    return saleReturn;
};

export const listSaleReturns = async (filters: {
    saleId?: string;
    from?: string;
    to?: string;
    cashSessionId?: string;
    /** Quién pregunta. Obligatorio para poder filtrar por turno (ver abajo). */
    requesterId?: string;
    requesterRoleSlug?: string | null;
}): Promise<SaleReturn[]> => {
    // Igual que en `listSales`: filtrar por turno es leer el turno, y las
    // devoluciones son justo lo que descuadra un corte. Sin esto un cajero
    // audita los reembolsos de otro pasando su `cashSessionId`.
    if (filters.cashSessionId) {
        const session = await cashSessionsRepo.getCashSessionById(filters.cashSessionId);
        if (!session) {
            throw notFound('Turno de caja');
        }
        assertCanAccessSession(session, filters.requesterId ?? '', filters.requesterRoleSlug);
    }
    return returnsRepo.listSaleReturns(filters);
};
