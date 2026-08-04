import { createHash } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
    ControlledGroup,
    PaymentMethod,
    PointPaymentSnapshot,
    Product,
    Sale,
    SaleBilling,
    SaleItem,
    SalePrescription,
} from '../types';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { buildListMeta, ListMeta, paginate, parsePagination } from '../utils/pagination';
import { allocateFefo } from '../utils/fefo';
import {
    breakdownLineTaxes,
    fromCents,
    prorateDiscount,
    sumTaxSummary,
    toCents,
} from '../utils/taxes';
import { db, now } from '../utils/firestore';
import * as productsRepo from '../repositories/products.repository';
import * as batchesRepo from '../repositories/batches.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as customersRepo from '../repositories/customers.repository';
import * as mercadoPagoService from './mercado-pago.service';
import {
    assertPrescriptionRules,
    resolveControlledRequirements,
    writeLedgerEntryInTransaction,
} from './controlled.service';
import { getControlledRule } from '../constants/controlled';
import { recordAudit } from './audit.service';
import { assertCanAccessSession } from './cash-sessions.service';

interface SaleItemInput {
    productId: string;
    quantity: number;
    discountAmount?: number;
}

const SALES_COUNTER_ID = 'sales';
const MAX_SALE_LINE_ITEMS = 100;
const MAX_NON_ADMIN_DISCOUNT_RATE = 0.2;
const IDEMPOTENCY_COLLECTION = 'saleIdempotencyKeys';
/** Ventana de reintento cubierta por la llave; después de esto el TTL de Firestore la borra. */
const IDEMPOTENCY_TTL_HOURS = 48;

const buildFolio = (sequence: number): string => `V-${String(sequence).padStart(6, '0')}`;

/**
 * La llave se guarda por cajero para que la llave de un cajero no pueda devolver
 * la venta de otro (los uuid los genera el cliente y no son de confianza).
 */
const buildIdempotencyDocId = (cashierId: string, key: string): string =>
    `${cashierId}:${key}`;

/**
 * Huella del cobro. Si llega la misma llave con un cobro distinto es un bug del
 * cliente (llave reciclada), no un retry: mejor fallar que devolver otra venta.
 */
const buildRequestFingerprint = (input: {
    items: SaleItem[];
    total: number;
    paymentMethod: PaymentMethod;
    cashSessionId: string;
}): string => createHash('sha256')
    .update(JSON.stringify({
        items: input.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: toCents(item.unitPrice),
            discountAmount: toCents(item.discountAmount),
        })),
        total: toCents(input.total),
        paymentMethod: input.paymentMethod,
        cashSessionId: input.cashSessionId,
    }))
    .digest('hex');

const mapSaleDoc = (doc: FirebaseFirestore.DocumentSnapshot): Sale => {
    const data = doc.data()!;
    return {
        id: doc.id,
        ...data,
        pointPayment: data.pointPayment ?? null,
        cardPaymentReference: data.cardPaymentReference ?? null,
    } as Sale;
};

/**
 * Resuelve una llave ya registrada: devuelve la venta original (retry legítimo) o
 * lanza si la huella del cobro no coincide.
 */
const resolveReplayedSale = (
    idemDoc: FirebaseFirestore.DocumentSnapshot,
    saleDoc: FirebaseFirestore.DocumentSnapshot,
    fingerprint: string,
): Sale => {
    const stored = idemDoc.data()!;
    if (stored.requestFingerprint !== fingerprint) {
        throw conflict(
            'Esta llave de idempotencia ya se usó para una venta distinta',
        );
    }
    if (!saleDoc.exists) {
        throw conflict(
            'La llave de idempotencia apunta a una venta que ya no existe',
        );
    }
    return mapSaleDoc(saleDoc);
};

interface TenderInput {
    paymentMethod: PaymentMethod;
    total: number;
    amountReceived?: number;
    cardPaymentReference?: string;
    /**
     * Monto cobrado con tarjeta (order Point). Obligatorio en `mixed`: es lo que
     * define cuánto falta cubrir en efectivo.
     */
    cardAmount?: number;
}

interface TenderResult {
    amountReceived: number | null;
    change: number | null;
    cashAmount: number | null;
    cardAmount: number | null;
    cardPaymentReference: string | null;
}

/**
 * Reparte el cobro entre efectivo y tarjeta.
 *
 *  - `cash`      — el efectivo recibido cubre el total; cambio = recibido − total.
 *  - `card`/`transfer` — sin efectivo.
 *  - `mixed`     — la tarjeta paga `cardAmount` y el efectivo cubre el resto
 *                  (`total − cardAmount`). El cambio se calcula contra **esa
 *                  parte en efectivo**, no contra el total: exigir que el efectivo
 *                  cubra el total completo era el bug histórico de `mixed`.
 */
const resolveTender = (input: TenderInput): TenderResult => {
    const { paymentMethod, total, amountReceived, cardPaymentReference } = input;

    if (paymentMethod === 'card' || paymentMethod === 'transfer') {
        if (paymentMethod === 'card' && !cardPaymentReference) {
            throw badRequest(
                'El pago con tarjeta requiere el id de la order de Mercado Pago Point',
            );
        }
        return {
            amountReceived: null,
            change: null,
            cashAmount: null,
            cardAmount: paymentMethod === 'card' ? total : null,
            cardPaymentReference: cardPaymentReference ?? null,
        };
    }

    if (amountReceived === undefined) {
        throw badRequest('El monto recibido es requerido para este método de pago');
    }

    if (paymentMethod === 'cash') {
        if (toCents(amountReceived) < toCents(total)) {
            throw badRequest('El monto recibido es menor al total de la venta');
        }
        return {
            amountReceived,
            change: fromCents(toCents(amountReceived) - toCents(total)),
            cashAmount: total,
            cardAmount: null,
            cardPaymentReference: null,
        };
    }

    // mixed
    if (!cardPaymentReference) {
        throw badRequest(
            'El pago mixto requiere el id de la order de Mercado Pago Point',
        );
    }
    if (input.cardAmount === undefined) {
        throw badRequest('El pago mixto requiere el monto cobrado con tarjeta');
    }

    const cardCents = toCents(input.cardAmount);
    const totalCents = toCents(total);
    if (cardCents <= 0) {
        throw badRequest('El monto cobrado con tarjeta debe ser mayor a cero');
    }
    if (cardCents >= totalCents) {
        throw badRequest(
            'La tarjeta cubre el total: registra la venta como pago con tarjeta',
        );
    }

    const cashCents = totalCents - cardCents;
    if (toCents(amountReceived) < cashCents) {
        throw badRequest(
            `El efectivo recibido no cubre la parte en efectivo (${fromCents(cashCents)})`,
        );
    }

    return {
        amountReceived,
        change: fromCents(toCents(amountReceived) - cashCents),
        cashAmount: fromCents(cashCents),
        cardAmount: fromCents(cardCents),
        cardPaymentReference,
    };
};

const resolvePointPayment = async (input: {
    paymentMethod: PaymentMethod;
    orderId: string | null;
    saleTotal: number;
}): Promise<PointPaymentSnapshot | null> => {
    if (input.paymentMethod !== 'card' && input.paymentMethod !== 'mixed') {
        return null;
    }
    if (!input.orderId) {
        throw badRequest(
            'El pago con tarjeta requiere el id de la order de Mercado Pago Point',
        );
    }

    const existing = await salesRepo.findSaleByPointOrderId(input.orderId);
    if (existing && !existing.voidedAt) {
        throw conflict('Esta order de Mercado Pago ya está asociada a una venta');
    }

    const order = await mercadoPagoService.getOrder(input.orderId);
    if (order.status !== 'processed') {
        throw badRequest(
            `La order de Mercado Pago no está pagada (estado: ${order.status})`,
        );
    }

    const paidCents = toCents(Number(order.amount));
    const totalCents = toCents(input.saleTotal);
    if (!Number.isFinite(paidCents) || paidCents <= 0) {
        throw badRequest('El monto de la order de Mercado Pago es inválido');
    }
    if (input.paymentMethod === 'card' && paidCents !== totalCents) {
        throw badRequest(
            'El monto de la order de Mercado Pago no coincide con el total de la venta',
        );
    }
    if (input.paymentMethod === 'mixed' && paidCents > totalCents) {
        throw badRequest(
            'El monto de la order de Mercado Pago supera el total de la venta',
        );
    }

    return {
        orderId: order.id,
        paymentId: order.paymentId,
        status: order.status,
        amount: order.amount,
        terminalId: order.terminalId,
        externalReference: order.externalReference,
    };
};

export const createSale = async (input: {
    idempotencyKey?: string;
    items: SaleItemInput[];
    saleDiscountAmount?: number;
    paymentMethod: PaymentMethod;
    amountReceived?: number;
    cardPaymentReference?: string;
    cashSessionId: string;
    cashierId: string;
    customerId?: string;
    customerName?: string;
    prescription?: SalePrescription;
    /** Confirmación de que la receta se retuvo (grupos I a III). */
    prescriptionRetained?: boolean;
    billing?: SaleBilling;
    roleSlug?: string;
}): Promise<Sale> => {
    if (!input.items.length) {
        throw badRequest('La venta debe tener al menos un producto');
    }
    if (input.items.length > MAX_SALE_LINE_ITEMS) {
        throw badRequest(
            `La venta no puede tener más de ${MAX_SALE_LINE_ITEMS} productos`,
        );
    }

    const firestore = db();
    const saleRef = firestore.collection('sales').doc();
    const cashSessionRef = firestore.collection('cashSessions').doc(input.cashSessionId);
    const counterRef = firestore.collection('counters').doc(SALES_COUNTER_ID);
    const timestamp = now();

    const saleItems: SaleItem[] = [];
    let subtotal = 0;
    let lineDiscountTotal = 0;

    type CachedProduct = Awaited<ReturnType<typeof productsRepo.getProductById>>;
    type CachedBatches = Awaited<ReturnType<typeof batchesRepo.listBatchesByProduct>>;

    const productCache = new Map<string, CachedProduct>();
    const batchCache = new Map<string, CachedBatches>();

    for (const item of input.items) {
        if (item.quantity <= 0) {
            throw badRequest('Cantidad inválida en un ítem de venta');
        }

        let product = productCache.get(item.productId);
        if (!product) {
            product = await productsRepo.getProductById(item.productId);
            productCache.set(item.productId, product);
        }

        if (!product || !product.isActive) {
            throw notFound(`Producto ${item.productId}`);
        }

        // Un producto con IEPS y sin tasa haría un desglose fiscal inventado: se
        // corrige en el catálogo, no aquí (productos históricos pueden no tenerla).
        if (product.hasIeps && product.iepsRate === undefined) {
            throw badRequest(
                `El producto ${product.name} tiene IEPS sin tasa configurada (iepsRate)`,
            );
        }

        let batches = batchCache.get(item.productId);
        if (!batches) {
            batches = await batchesRepo.listBatchesByProduct(item.productId);
            batchCache.set(item.productId, batches);
        }

        let allocations;
        try {
            allocations = allocateFefo(batches, item.quantity, { excludeExpired: true });
        } catch (error) {
            if (error instanceof Error && error.message === 'EXPIRED_STOCK') {
                throw badRequest(`El stock disponible de ${product.name} está vencido`);
            }
            throw badRequest(`Stock insuficiente para ${product.name}`);
        }

        for (const allocation of allocations) {
            const batch = batches.find((entry) => entry.id === allocation.batchId);
            if (batch) {
                batch.quantity -= allocation.quantity;
            }
        }

        const itemSubtotal = product.salePrice * item.quantity;
        const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
        subtotal += itemSubtotal;
        lineDiscountTotal += discountAmount;

        saleItems.push({
            productId: product.id,
            productName: product.name,
            quantity: item.quantity,
            unitPrice: product.salePrice,
            discountAmount,
            subtotal: itemSubtotal,
            batchAllocations: allocations,
        });
    }

    // Reglas de receta por grupo COFEPRIS (folio y retención en I a III).
    const cartProducts = [...productCache.values()].filter(Boolean) as Product[];
    const controlled = resolveControlledRequirements(cartProducts);
    assertPrescriptionRules({
        requirements: controlled,
        prescription: input.prescription,
        prescriptionRetained: input.prescriptionRetained,
    });

    const customerId: string | null = input.customerId ?? null;
    let customerName: string | null = input.customerName?.trim() ?? null;
    if (customerId) {
        const customer = await customersRepo.getCustomerById(customerId);
        if (!customer) {
            throw notFound('Cliente');
        }
        customerName = customerName || customer.name;
    }

    const billing = input.billing
        ? {
            rfc: input.billing.rfc.trim().toUpperCase(),
            name: input.billing.name.trim(),
            usoCfdi: input.billing.usoCfdi?.trim(),
            email: input.billing.email?.trim(),
        }
        : null;
    const prescription = input.prescription
        ? {
            doctorName: input.prescription.doctorName.trim(),
            doctorLicense: input.prescription.doctorLicense.trim(),
            folio: input.prescription.folio?.trim(),
        }
        : null;

    const saleDiscountAmount = Math.min(
        Math.max(0, input.saleDiscountAmount ?? 0),
        subtotal - lineDiscountTotal,
    );
    const discountTotal = lineDiscountTotal + saleDiscountAmount;
    const total = subtotal - discountTotal;

    // El descuento a nivel venta se prorratea antes de desglosar impuestos: si no,
    // se declararía IVA sobre un importe que nunca se cobró.
    const lineNetsBeforeSaleDiscount = saleItems.map(
        (item) => item.subtotal - item.discountAmount,
    );
    const saleDiscountShares = prorateDiscount(
        lineNetsBeforeSaleDiscount,
        saleDiscountAmount,
    );

    saleItems.forEach((item, index) => {
        const product = productCache.get(item.productId)!;
        const netAmount = lineNetsBeforeSaleDiscount[index] - saleDiscountShares[index];
        item.saleDiscountShare = saleDiscountShares[index];
        item.netAmount = netAmount;
        item.taxes = breakdownLineTaxes({
            grossAmount: netAmount,
            hasIva: product.hasIva,
            hasIvaZero: product.hasIvaZero,
            hasIeps: product.hasIeps,
            iepsRate: product.iepsRate,
        });
    });

    const taxSummary = sumTaxSummary(saleItems.map((item) => item.taxes!));

    // COGS por partida desde el costo de los lotes asignados. Si a un lote le falta
    // `costPrice`, la partida queda en `null` y el reporte de margen lo reporta como
    // "sin costo" en lugar de inflar la utilidad con un cero.
    const costByBatchId = new Map<string, number | undefined>();
    for (const batches of batchCache.values()) {
        for (const batch of batches) {
            costByBatchId.set(batch.id, batch.costPrice);
        }
    }
    for (const item of saleItems) {
        let costCents = 0;
        let costKnown = true;
        for (const allocation of item.batchAllocations) {
            const costPrice = costByBatchId.get(allocation.batchId);
            if (costPrice === undefined) {
                costKnown = false;
                break;
            }
            costCents += toCents(costPrice) * allocation.quantity;
        }
        item.costAmount = costKnown ? costCents / 100 : null;
    }
    const costTotal = saleItems.every((item) => item.costAmount !== null)
        ? saleItems.reduce((total, item) => total + (item.costAmount ?? 0), 0)
        : null;

    const overCapLines = saleItems.filter(
        (item) => toCents(item.discountAmount) >
            toCents(item.subtotal * MAX_NON_ADMIN_DISCOUNT_RATE),
    );
    const discountOverCap = overCapLines.length > 0 ||
        toCents(discountTotal) > toCents(subtotal * MAX_NON_ADMIN_DISCOUNT_RATE);

    if (input.roleSlug !== 'admin') {
        const lineOverCap = saleItems.find(
            (item) => toCents(item.discountAmount) >
                toCents(item.subtotal * MAX_NON_ADMIN_DISCOUNT_RATE),
        );
        if (lineOverCap) {
            throw forbidden(
                'Solo un administrador puede aplicar descuentos mayores al ' +
                `${MAX_NON_ADMIN_DISCOUNT_RATE * 100}% (${lineOverCap.productName})`,
            );
        }
        if (toCents(discountTotal) > toCents(subtotal * MAX_NON_ADMIN_DISCOUNT_RATE)) {
            throw forbidden(
                'Solo un administrador puede aplicar un descuento total mayor al ' +
                `${MAX_NON_ADMIN_DISCOUNT_RATE * 100}%`,
            );
        }
    }

    // Corto circuito de idempotencia antes de cobrar/consultar Mercado Pago: un
    // retry de red no debe crear una segunda venta ni chocar con la validación de
    // "esta order ya está asociada a una venta".
    const fingerprint = buildRequestFingerprint({
        items: saleItems,
        total,
        paymentMethod: input.paymentMethod,
        cashSessionId: input.cashSessionId,
    });
    const idempotencyRef = input.idempotencyKey
        ? firestore
            .collection(IDEMPOTENCY_COLLECTION)
            .doc(buildIdempotencyDocId(input.cashierId, input.idempotencyKey))
        : null;

    if (idempotencyRef) {
        const idemDoc = await idempotencyRef.get();
        if (idemDoc.exists) {
            const existingSaleDoc = await firestore
                .collection('sales')
                .doc(idemDoc.data()!.saleId as string)
                .get();
            return resolveReplayedSale(idemDoc, existingSaleDoc, fingerprint);
        }
    }

    // La order Point se resuelve ANTES del tender: en pago mixto su monto es lo que
    // define cuánto falta cubrir en efectivo.
    const pointPayment = await resolvePointPayment({
        paymentMethod: input.paymentMethod,
        orderId: input.cardPaymentReference ?? null,
        saleTotal: total,
    });
    const tender = resolveTender({
        paymentMethod: input.paymentMethod,
        total,
        amountReceived: input.amountReceived,
        cardPaymentReference: input.cardPaymentReference,
        ...(pointPayment ? { cardAmount: Number(pointPayment.amount) } : {}),
    });

    // Firestore exige que todas las lecturas de una transacción ocurran antes
    // que cualquier escritura: cuando una venta reparte stock entre 2+ lotes
    // (lo normal en FEFO) hay que leer todos los lotes primero y recién luego
    // escribir todos los updates/movimientos.
    const allocationRefs = saleItems.flatMap((item) =>
        item.batchAllocations.map((allocation) => ({
            item,
            allocation,
            batchRef: firestore.collection('batches').doc(allocation.batchId),
        })),
    );

    const qtyByBatchId = new Map<string, {
        batchRef: FirebaseFirestore.DocumentReference;
        productId: string;
        quantity: number;
    }>();
    for (const { item, allocation, batchRef } of allocationRefs) {
        const existing = qtyByBatchId.get(allocation.batchId);
        if (existing) {
            existing.quantity += allocation.quantity;
        } else {
            qtyByBatchId.set(allocation.batchId, {
                batchRef,
                productId: item.productId,
                quantity: allocation.quantity,
            });
        }
    }
    const uniqueBatchEntries = [...qtyByBatchId.entries()];

    // Lote por asignación: el libro de control necesita el número de lote, no el id.
    const lotNumberByBatchId = new Map<string, string>();
    for (const batches of batchCache.values()) {
        for (const batch of batches) {
            lotNumberByBatchId.set(batch.id, batch.lotNumber);
        }
    }

    const sale = await firestore.runTransaction(async (transaction) => {
        // Segundo chequeo dentro de la transacción: dos requests simultáneos con la
        // misma llave contienden por este documento y el perdedor reintenta, ve la
        // venta ya escrita y la devuelve en lugar de duplicarla.
        const idemDoc = idempotencyRef ? await transaction.get(idempotencyRef) : null;
        if (idemDoc?.exists) {
            const existingSaleDoc = await transaction.get(
                firestore.collection('sales').doc(idemDoc.data()!.saleId as string),
            );
            return resolveReplayedSale(idemDoc, existingSaleDoc, fingerprint);
        }

        const [cashSessionDoc, counterDoc, ...batchDocs] = await Promise.all([
            transaction.get(cashSessionRef),
            transaction.get(counterRef),
            ...uniqueBatchEntries.map(([, entry]) => transaction.get(entry.batchRef)),
        ]);

        if (!cashSessionDoc.exists) {
            throw notFound('Turno de caja');
        }
        // El turno es de quien lo abrió: sin esto un cajero puede cargar ventas en
        // efectivo al turno de otro y dejarle el faltante en su corte.
        assertCanAccessSession(
            { openedBy: cashSessionDoc.data()!.openedBy as string },
            input.cashierId,
            input.roleSlug,
        );
        if (cashSessionDoc.data()?.closedAt) {
            throw badRequest('El turno de caja ya está cerrado');
        }

        const nextSequence = (counterDoc.data()?.value as number | undefined ?? 0) + 1;
        const folio = buildFolio(nextSequence);

        uniqueBatchEntries.forEach(([batchId, entry], index) => {
            const batchDoc = batchDocs[index];
            if (!batchDoc.exists) {
                throw notFound('Lote');
            }

            const currentQty = batchDoc.data()?.quantity as number;
            if (currentQty < entry.quantity) {
                throw badRequest(`Stock insuficiente en lote ${batchId}`);
            }

            transaction.update(entry.batchRef, {
                quantity: currentQty - entry.quantity,
                updatedAt: timestamp,
            });
        });

        allocationRefs.forEach(({ item, allocation }) => {
            const movementRef = firestore.collection('stockMovements').doc();
            transaction.set(movementRef, {
                type: 'sale_adjustment',
                productId: item.productId,
                batchId: allocation.batchId,
                quantity: allocation.quantity,
                referenceId: saleRef.id,
                userId: input.cashierId,
                createdAt: timestamp,
            });
        });

        transaction.set(counterRef, { value: nextSequence }, { merge: true });

        const productIds = [...new Set(saleItems.map((item) => item.productId))];
        const stockDeltaByProduct = new Map<string, number>();
        for (const item of saleItems) {
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + item.quantity,
            );
        }

        for (const [productId, delta] of stockDeltaByProduct) {
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: FieldValue.increment(-delta),
                updatedAt: timestamp,
            });
        }

        const saleData = {
            folio,
            productIds,
            items: saleItems,
            subtotal,
            discountTotal,
            total,
            taxSummary,
            costTotal,
            refundedTotal: 0,
            paymentMethod: input.paymentMethod,
            amountReceived: tender.amountReceived,
            change: tender.change,
            cashAmount: tender.cashAmount,
            cardAmount: tender.cardAmount,
            cardPaymentReference: pointPayment?.orderId ?? tender.cardPaymentReference,
            pointPayment,
            cashSessionId: input.cashSessionId,
            cashierId: input.cashierId,
            customerId,
            customerName,
            prescription,
            prescriptionRetained: Boolean(input.prescriptionRetained),
            controlledGroups: controlled.groups,
            billing,
            invoiceStatus: billing ? ('pending' as const) : null,
            voidedAt: null,
            voidedBy: null,
            createdAt: timestamp,
        };

        if (idempotencyRef) {
            transaction.create(idempotencyRef, {
                saleId: saleRef.id,
                folio,
                cashierId: input.cashierId,
                requestFingerprint: fingerprint,
                createdAt: timestamp,
                // Campo para la política TTL de Firestore sobre esta colección.
                expiresAt: Timestamp.fromMillis(
                    timestamp.toMillis() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
                ),
            });
        }

        // Libro de control: un renglón por partida de grupo controlado, en la misma
        // transacción que la venta.
        for (const item of saleItems) {
            const rule = getControlledRule(productCache.get(item.productId)?.controlledGroup);
            if (!rule?.requiresLedger) {
                continue;
            }
            writeLedgerEntryInTransaction(transaction, {
                type: 'sale',
                saleId: saleRef.id,
                saleFolio: folio,
                referenceFolio: null,
                productId: item.productId,
                productName: item.productName,
                controlledGroup: rule.group,
                quantity: item.quantity,
                lotNumbers: item.batchAllocations
                    .map((allocation) => lotNumberByBatchId.get(allocation.batchId))
                    .filter((lot): lot is string => Boolean(lot)),
                prescription,
                prescriptionRetained: Boolean(input.prescriptionRetained),
                customerName,
                userId: input.cashierId,
                createdAt: timestamp,
            });
        }

        transaction.set(saleRef, saleData);
        return { id: saleRef.id, ...saleData };
    });

    // Descuento por encima del tope: lo permitió un administrador, así que queda
    // en la bitácora con el monto y quién lo autorizó.
    if (discountOverCap) {
        await recordAudit({
            action: 'sale.discount_override',
            entity: 'sale',
            entityId: sale.id,
            summary: `Descuento de ${discountTotal.toFixed(2)} sobre ${subtotal.toFixed(2)} ` +
                `en la venta ${sale.folio} (arriba del ${MAX_NON_ADMIN_DISCOUNT_RATE * 100}%)`,
            userId: input.cashierId,
            roleSlug: input.roleSlug ?? null,
            metadata: {
                folio: sale.folio,
                subtotal,
                discountTotal,
                lineOverCap: overCapLines.map((item) => ({
                    productId: item.productId,
                    productName: item.productName,
                    discountAmount: item.discountAmount,
                })),
            },
        });
    }

    return sale;
};

export const voidSale = async (id: string, voidedBy: string, roleSlug?: string): Promise<Sale> => {
    const firestore = db();
    const saleRef = firestore.collection('sales').doc(id);

    const sale = await firestore.runTransaction(async (transaction) => {
        const saleDoc = await transaction.get(saleRef);
        if (!saleDoc.exists) {
            throw notFound('Venta');
        }
        const existing = mapSaleDoc(saleDoc);
        if (existing.voidedAt) {
            throw badRequest('La venta ya está anulada');
        }
        // Anular después de devolver parcialmente restauraría stock dos veces y
        // devolvería dinero de más: primero se cancela la devolución.
        if ((existing.refundedTotal ?? 0) > 0) {
            throw conflict(
                'La venta tiene devoluciones registradas; no se puede anular completa',
            );
        }

        const batchRefs = existing.items.flatMap((item) =>
            item.batchAllocations.map((allocation) => ({
                item,
                allocation,
                batchRef: firestore.collection('batches').doc(allocation.batchId),
            })),
        );

        const restoreByBatchId = new Map<string, {
            batchRef: FirebaseFirestore.DocumentReference;
            quantity: number;
        }>();
        for (const { allocation, batchRef } of batchRefs) {
            const existingRestore = restoreByBatchId.get(allocation.batchId);
            if (existingRestore) {
                existingRestore.quantity += allocation.quantity;
            } else {
                restoreByBatchId.set(allocation.batchId, {
                    batchRef,
                    quantity: allocation.quantity,
                });
            }
        }
        const uniqueRestores = [...restoreByBatchId.entries()];

        const productIds = [...new Set(existing.items.map((item) => item.productId))];
        const [batchDocs, productDocs] = await Promise.all([
            Promise.all(uniqueRestores.map(([, entry]) => transaction.get(entry.batchRef))),
            Promise.all(productIds.map((productId) =>
                transaction.get(firestore.collection('products').doc(productId)))),
        ]);

        const productGroupById = new Map<string, ControlledGroup | undefined>();
        productIds.forEach((productId, index) => {
            productGroupById.set(
                productId,
                productDocs[index].data()?.controlledGroup as ControlledGroup | undefined,
            );
        });

        const timestamp = now();

        uniqueRestores.forEach(([, entry], index) => {
            const batchDoc = batchDocs[index];
            if (!batchDoc.exists) {
                throw notFound('Lote');
            }
            const currentQty = batchDoc.data()?.quantity as number;
            transaction.update(entry.batchRef, {
                quantity: currentQty + entry.quantity,
                updatedAt: timestamp,
            });
        });

        batchRefs.forEach(({ item, allocation }) => {
            const movementRef = firestore.collection('stockMovements').doc();
            transaction.set(movementRef, {
                type: 'sale_adjustment',
                productId: item.productId,
                batchId: allocation.batchId,
                quantity: -allocation.quantity,
                referenceId: saleRef.id,
                userId: voidedBy,
                createdAt: timestamp,
            });
        });

        const stockDeltaByProduct = new Map<string, number>();
        for (const item of existing.items) {
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + item.quantity,
            );
        }
        for (const [productId, delta] of stockDeltaByProduct) {
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: FieldValue.increment(delta),
                updatedAt: timestamp,
            });
        }

        // Reversa en el libro de control: cantidad negativa, un renglón por partida
        // controlada. El libro nunca se borra, se contra-asienta.
        for (const item of existing.items) {
            const group = productGroupById.get(item.productId);
            const rule = getControlledRule(group);
            if (!rule?.requiresLedger) {
                continue;
            }
            writeLedgerEntryInTransaction(transaction, {
                type: 'void',
                saleId: existing.id,
                saleFolio: existing.folio,
                referenceFolio: null,
                productId: item.productId,
                productName: item.productName,
                controlledGroup: rule.group,
                quantity: -item.quantity,
                lotNumbers: [],
                prescription: existing.prescription,
                prescriptionRetained: Boolean(existing.prescriptionRetained),
                customerName: existing.customerName,
                userId: voidedBy,
                createdAt: timestamp,
            });
        }

        transaction.update(saleRef, { voidedAt: timestamp, voidedBy });

        return { ...existing, voidedAt: timestamp, voidedBy };
    });

    await recordAudit({
        action: 'sale.voided',
        entity: 'sale',
        entityId: sale.id,
        summary: `Venta ${sale.folio} anulada por ${sale.total.toFixed(2)}`,
        userId: voidedBy,
        roleSlug: roleSlug ?? null,
        metadata: {
            folio: sale.folio,
            total: sale.total,
            paymentMethod: sale.paymentMethod,
            items: sale.items.length,
        },
    });

    return sale;
};

export const getSale = async (id: string): Promise<Sale> => {
    const sale = await salesRepo.getSaleById(id);
    if (!sale) {
        throw notFound('Venta');
    }
    return sale;
};

export const listSales = async (filters: {
    from?: string;
    to?: string;
    cashSessionId?: string;
    includeVoided?: boolean;
    search?: string;
    page?: number;
    limit?: number;
}): Promise<{ items: Sale[]; meta: ListMeta }> => {
    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items: sales } = await salesRepo.listSales({
        from: filters.from,
        to: filters.to,
        cashSessionId: filters.cashSessionId,
        includeVoided: filters.includeVoided,
    });

    let filtered = sales;

    if (filters.search) {
        const term = filters.search.toLowerCase();
        filtered = filtered.filter((sale) =>
            sale.folio.toLowerCase().includes(term) ||
            sale.items.some((item) => item.productName.toLowerCase().includes(term)),
        );
    }

    const paginated = paginate(filtered, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

/** Anulación de ventas: solo el rol de sistema `admin` (no un área de permiso). */
export const assertCanVoidSale = (roleSlug: string): void => {
    if (roleSlug !== 'admin') {
        throw forbidden('Solo un administrador puede anular una venta');
    }
};
