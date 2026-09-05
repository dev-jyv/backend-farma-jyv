import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import {
    ControlledGroup,
    PaymentMethod,
    PointPaymentSnapshot,
    Product,
    Sale,
    SaleBilling,
    SaleLineItem,
    SalePrescription,
    isSaleProductItem,
    isSaleServiceItem,
    saleItemName,
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
import * as pharmacyServicesRepo from '../repositories/pharmacy-services.repository';
import * as serviceProvidersRepo from '../repositories/service-providers.repository';
import * as salesRepo from '../repositories/sales.repository';
import * as cashSessionsRepo from '../repositories/cash-sessions.repository';
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
import { hasPermission } from '../constants/permissions';
import { RolePermission } from '../types';

interface SaleProductItemInput {
    /** Ausente en los payloads del POS anterior a los servicios: se lee como mercancía. */
    kind?: 'product';
    productId: string;
    quantity: number;
    discountAmount?: number;
    /** Precio cobrado; ausente en clientes anteriores (manda el catálogo). */
    unitPrice?: number;
}

interface SaleServiceItemInput {
    kind: 'service';
    serviceId: string;
    quantity: number;
    discountAmount?: number;
    /** Doctor del catálogo `serviceProviders`, **no** un uid del sistema. */
    providerId?: string | null;
}

export type SaleItemInput = SaleProductItemInput | SaleServiceItemInput;

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
    items: SaleLineItem[];
    total: number;
    paymentMethod: PaymentMethod;
    cashSessionId: string;
}): string => createHash('sha256')
    .update(JSON.stringify({
        // La partida de mercancía conserva **exactamente** la forma de siempre:
        // cambiarla invalidaría las llaves vivas (48 h de TTL) y un retry legítimo
        // de una venta ya registrada respondería "llave usada para otra venta".
        items: input.items.map((item) => (isSaleServiceItem(item)
            ? {
                kind: 'service',
                serviceId: item.serviceId,
                quantity: item.quantity,
                unitPrice: toCents(item.unitPrice),
                discountAmount: toCents(item.discountAmount),
            }
            : {
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
        // Sin `cardPaymentReference` la venta queda como **registro** del cobro con
        // tarjeta, igual que el efectivo: nadie prueba que el dinero entró, lo
        // afirma el cajero. Cuando hay terminal Point emparejada, la order sí lo
        // prueba y se sigue exigiendo (ver `resolvePointPayment`).
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
    // Lo que el mixto necesita es el **reparto**, no la order: con terminal viene
    // del monto de la order; sin terminal lo captura el cajero.
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
        // Sin terminal Point no hay referencia que guardar: el mixto queda como
        // registro del reparto, igual que la parte en efectivo.
        cardPaymentReference: cardPaymentReference ?? null,
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
        // Cobro con tarjeta registrado a mano (sin terminal emparejada): no hay
        // order que validar. El tender resuelve el reparto con lo que mandó el POS.
        return null;
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
    /** Reparto con tarjeta en mixto sin terminal Point (ver `resolveTender`). */
    cardAmount?: number;
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

    const saleItems: SaleLineItem[] = [];
    let subtotal = 0;
    let lineDiscountTotal = 0;

    type CachedProduct = Awaited<ReturnType<typeof productsRepo.getProductById>>;
    type CachedBatches = Awaited<ReturnType<typeof batchesRepo.listBatchesByProduct>>;
    type CachedService = Awaited<
        ReturnType<typeof pharmacyServicesRepo.getPharmacyServiceById>
    >;

    const productCache = new Map<string, CachedProduct>();
    const batchCache = new Map<string, CachedBatches>();
    // Catálogo de servicios de la venta: el desglose fiscal y la comisión se
    // resuelven después de prorratear el descuento, así que hace falta volver a
    // consultarlo por partida sin pagar otra lectura.
    const serviceCache = new Map<string, CachedService>();
    // Suma de lotes ANTES de asignar FEFO. Si `products.totalStock` no existe
    // (productos previos a la denormalización), FieldValue.increment(-n) parte
    // de 0 y deja stock negativo aunque los lotes sí tenían piezas.
    const batchStockBefore = new Map<string, number>();

    for (const item of input.items) {
        if (item.quantity <= 0) {
            throw badRequest('Cantidad inválida en un ítem de venta');
        }

        // Rama de servicio: no toca inventario, no entra al libro de controlados y
        // congela la comisión del doctor. Todo lo demás (descuentos, impuestos,
        // reparto del efectivo) sigue el mismo camino que la mercancía.
        if (item.kind === 'service') {
            let service = serviceCache.get(item.serviceId);
            if (!service) {
                service = await pharmacyServicesRepo.getPharmacyServiceById(item.serviceId);
                serviceCache.set(item.serviceId, service);
            }
            if (!service || !service.isActive) {
                throw notFound(`Servicio ${item.serviceId}`);
            }
            if (service.hasIeps && service.iepsRate === undefined) {
                throw badRequest(
                    `El servicio ${service.name} tiene IEPS sin tasa configurada (iepsRate)`,
                );
            }

            // El doctor se valida siempre que venga; que sea **obligatorio** lo
            // decide el catálogo (`requiresPerformer`), no el payload.
            let provider = null;
            if (item.providerId) {
                provider = await serviceProvidersRepo.getServiceProviderById(item.providerId);
                if (!provider || !provider.isActive) {
                    throw notFound(`Doctor ${item.providerId}`);
                }
            }
            if (service.requiresPerformer && !provider) {
                throw badRequest(
                    `El servicio ${service.name} requiere indicar quién lo realizó`,
                );
            }

            // Comisión congelada al cobrar: manda la del servicio y, solo si es 0,
            // se cae a la del doctor. El catálogo puede cambiar mañana; esta venta no.
            const commissionRate = service.commissionRate > 0
                ? service.commissionRate
                : provider?.defaultCommissionRate ?? 0;

            const itemSubtotal = service.price * item.quantity;
            const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
            subtotal += itemSubtotal;
            lineDiscountTotal += discountAmount;

            saleItems.push({
                kind: 'service',
                serviceId: service.id,
                serviceName: service.name,
                quantity: item.quantity,
                unitPrice: service.price,
                discountAmount,
                subtotal: itemSubtotal,
                providerId: provider?.id ?? null,
                providerName: provider?.name ?? null,
                commissionRate,
                // Se calcula sobre el importe **neto**, que aún no se conoce: el
                // descuento a nivel venta se prorratea más abajo.
                commissionAmount: 0,
            });
            continue;
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
            batchStockBefore.set(
                item.productId,
                batches.reduce((sum, batch) => sum + batch.quantity, 0),
            );
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

        // Precio **cobrado**, no el de catálogo de hoy. Una venta sin conexión se
        // sincroniza horas o días después; si el precio subió entre medias, tarifar
        // con el nuevo dejaba el `amountReceived` corto y el backend rechazaba una
        // venta que el cliente ya había pagado. El catálogo solo manda cuando el
        // POS no informa precio (ventas anteriores a este campo).
        const unitPrice = item.unitPrice ?? product.salePrice;
        const itemSubtotal = unitPrice * item.quantity;
        const discountAmount = Math.min(Math.max(0, item.discountAmount ?? 0), itemSubtotal);
        subtotal += itemSubtotal;
        lineDiscountTotal += discountAmount;

        saleItems.push({
            kind: 'product',
            productId: product.id,
            productName: product.name,
            quantity: item.quantity,
            unitPrice,
            // Precio de catálogo al momento de registrar. Se guarda solo cuando
            // difiere de lo cobrado: es la señal auditable de que el POS tarifó
            // distinto, y evita que un precio manipulado pase inadvertido.
            ...(unitPrice !== product.salePrice ? { catalogUnitPrice: product.salePrice } : {}),
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
        const netAmount = lineNetsBeforeSaleDiscount[index] - saleDiscountShares[index];
        item.saleDiscountShare = saleDiscountShares[index];
        item.netAmount = netAmount;

        if (isSaleServiceItem(item)) {
            const service = serviceCache.get(item.serviceId)!;
            item.taxes = breakdownLineTaxes({
                grossAmount: netAmount,
                // El `taxMode` del servicio se traduce a las mismas banderas
                // fiscales del producto: `exempt` y `zero` ⇒ IVA 0, `iva16` ⇒ 16 %.
                hasIva: service.taxMode === 'iva16',
                hasIvaZero: service.taxMode === 'zero',
                hasIeps: service.hasIeps,
                iepsRate: service.iepsRate,
            });
            // La comisión se acredita sobre lo realmente cobrado por la partida.
            item.commissionAmount = fromCents(
                Math.round((toCents(netAmount) * item.commissionRate) / 100),
            );
            return;
        }

        const product = productCache.get(item.productId)!;
        item.taxes = breakdownLineTaxes({
            grossAmount: netAmount,
            hasIva: product.hasIva,
            hasIvaZero: product.hasIvaZero,
            hasIeps: product.hasIeps,
            iepsRate: product.iepsRate,
        });
    });

    const taxSummary = sumTaxSummary(saleItems.map((item) => item.taxes!));

    // Las dos ramas de la venta. Son referencias a las mismas partidas de
    // `saleItems`, no copias: lo que se les escriba sigue viéndose en el documento.
    const productItems = saleItems.filter(isSaleProductItem);
    const serviceItems = saleItems.filter(isSaleServiceItem);

    // COGS por partida desde el costo de los lotes asignados. Si a un lote le falta
    // `costPrice`, la partida queda en `null` y el reporte de margen lo reporta como
    // "sin costo" en lugar de inflar la utilidad con un cero. Un servicio no tiene
    // costo de mercancía: queda fuera del cálculo, no cuenta como "sin costo".
    const costByBatchId = new Map<string, number | undefined>();
    for (const batches of batchCache.values()) {
        for (const batch of batches) {
            costByBatchId.set(batch.id, batch.costPrice);
        }
    }
    for (const item of productItems) {
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
    const costTotal = productItems.every((item) => item.costAmount !== null)
        ? productItems.reduce((total, item) => total + (item.costAmount ?? 0), 0)
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
                `${MAX_NON_ADMIN_DISCOUNT_RATE * 100}% (${saleItemName(lineOverCap)})`,
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
        // La order manda cuando existe; si no, el reparto capturado en el POS.
        ...(pointPayment
            ? { cardAmount: Number(pointPayment.amount) }
            : input.cardAmount !== undefined && input.cardAmount !== null
                ? { cardAmount: input.cardAmount }
                : {}),
    });

    /**
     * Denormalizados del cobro de servicios. **Los decide el servidor**: el
     * payload propone partidas, no totales.
     *
     * `pharmacyTotal` se obtiene restando en centavos, no sumando la rama de
     * mercancía, para que `pharmacyTotal + servicesTotal === total` se cumpla
     * exacto y no dependa del redondeo de cada partida.
     */
    const servicesTotalCents = serviceItems.reduce(
        (sum, item) => sum + toCents(item.netAmount ?? 0),
        0,
    );
    const servicesTotal = fromCents(servicesTotalCents);
    const pharmacyTotal = fromCents(toCents(total) - servicesTotalCents);
    const commissionTotalCents = serviceItems.reduce(
        (sum, item) => sum + toCents(item.commissionAmount),
        0,
    );
    const commissionByProviderCents = new Map<string, number>();
    for (const item of serviceItems) {
        if (!item.providerId) {
            continue;
        }
        commissionByProviderCents.set(
            item.providerId,
            (commissionByProviderCents.get(item.providerId) ?? 0) +
                toCents(item.commissionAmount),
        );
    }

    /**
     * Reparto del efectivo: **servicios primero**. El efectivo cubre los
     * servicios y lo que sobra es de farmacia; no se prorratea. Es una regla del
     * negocio, no una aproximación.
     */
    const cashAmountCents = toCents(tender.cashAmount ?? 0);
    const servicesCashCents = Math.min(cashAmountCents, servicesTotalCents);
    const servicesCashAmount = fromCents(servicesCashCents);
    const pharmacyCashAmount = fromCents(cashAmountCents - servicesCashCents);

    // Firestore exige que todas las lecturas de una transacción ocurran antes
    // que cualquier escritura: cuando una venta reparte stock entre 2+ lotes
    // (lo normal en FEFO) hay que leer todos los lotes primero y recién luego
    // escribir todos los updates/movimientos. Solo la mercancía mueve lotes.
    const allocationRefs = productItems.flatMap((item) =>
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

        // Solo mercancía: los reportes resuelven cada id de `productIds` contra
        // `products`, así que un id de servicio aquí los revienta.
        const productIds = [...new Set(productItems.map((item) => item.productId))];
        const stockDeltaByProduct = new Map<string, number>();
        for (const item of productItems) {
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + item.quantity,
            );
        }

        const [cashSessionDoc, counterDoc, ...batchAndProductDocs] = await Promise.all([
            transaction.get(cashSessionRef),
            transaction.get(counterRef),
            ...uniqueBatchEntries.map(([, entry]) => transaction.get(entry.batchRef)),
            ...productIds.map((productId) =>
                transaction.get(firestore.collection('products').doc(productId))),
        ]);
        const batchDocs = batchAndProductDocs.slice(0, uniqueBatchEntries.length);
        const productDocs = batchAndProductDocs.slice(uniqueBatchEntries.length);

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

        productIds.forEach((productId, index) => {
            const delta = stockDeltaByProduct.get(productId) ?? 0;
            const denorm = productDocs[index].data()?.totalStock;
            const baseline = typeof denorm === 'number'
                ? denorm
                : (batchStockBefore.get(productId) ?? delta);
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: Math.max(0, baseline - delta),
                updatedAt: timestamp,
            });
        });

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
            hasServices: serviceItems.length > 0,
            serviceIds: [...new Set(serviceItems.map((item) => item.serviceId))],
            providerIds: [...commissionByProviderCents.keys()],
            commissionTotal: fromCents(commissionTotalCents),
            commissionByProvider: Object.fromEntries(
                [...commissionByProviderCents].map(([providerId, cents]) => [
                    providerId,
                    fromCents(cents),
                ]),
            ),
            pharmacyTotal,
            servicesTotal,
            pharmacyCashAmount,
            servicesCashAmount,
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
        // transacción que la venta. Un servicio no es una sustancia controlada:
        // la rama de servicios no entra al libro.
        for (const item of productItems) {
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
                    productId: isSaleServiceItem(item) ? item.serviceId : item.productId,
                    productName: saleItemName(item),
                    discountAmount: item.discountAmount,
                })),
            },
        });
    }

    return sale;
};

export const voidSale = async (
    id: string,
    voidedBy: string,
    roleSlug?: string,
    /**
     * Datos que reporta el POS cuando la anulación ocurrió **sin red** y se está
     * cerrando en el siguiente sync: el instante y el cajero de entonces. Sin
     * esto, la venta quedaría anulada con la hora del sync y a nombre de quien
     * sincronizó, que puede ser otro turno y otra persona.
     */
    reported?: { voidedAt?: string; voidedBy?: string },
): Promise<Sale> => {
    const firestore = db();
    const saleRef = firestore.collection('sales').doc(id);

    // Fuera de la transacción: Firestore exige que todas sus lecturas ocurran
    // antes de cualquier escritura, y esto solo decide quién puede anular.
    const saleSnapshot = await saleRef.get();
    const sesionId = saleSnapshot.exists
        ? ((saleSnapshot.data()?.cashSessionId as string | null) ?? null)
        : null;
    const sesionCerrada = sesionId
        ? Boolean((await cashSessionsRepo.getCashSessionById(sesionId))?.closedAt)
        : false;

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
        // Un turno cerrado ya tiene su arqueo firmado: cambiarle una venta lo
        // descuadra hacia atrás. Ahí la anulación deja de ser rutina de
        // mostrador y pasa a ser decisión de administración.
        if (sesionCerrada && roleSlug !== 'admin') {
            throw forbidden(
                'La venta pertenece a un turno ya cerrado: solo un administrador puede anularla',
            );
        }
        if ((existing.refundedTotal ?? 0) > 0) {
            throw conflict(
                'La venta tiene devoluciones registradas; no se puede anular completa',
            );
        }

        /**
         * La anulación solo revierte la rama de mercancía: reposición de lotes,
         * movimientos negativos y contra-asiento del libro. Las partidas de
         * servicio no dejaron rastro que revertir —solo quedan marcadas por el
         * `voidedAt`/`voidedBy` de la venta.
         */
        const voidedProductItems = existing.items.filter(isSaleProductItem);

        const batchRefs = voidedProductItems.flatMap((item) =>
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

        const productIds = [...new Set(voidedProductItems.map((item) => item.productId))];
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

        /**
         * Instante de la anulación. Se acepta el reportado por la caja solo si
         * es coherente —no futuro y no anterior a la venta—: un reloj desfasado
         * en el equipo no debe escribir una línea de tiempo imposible en la
         * bitácora ni en el libro de control.
         */
        const serverNow = now();
        const reportedAt = reported?.voidedAt ? Timestamp.fromDate(new Date(reported.voidedAt)) : null;
        const reportedIsSane = reportedAt !== null &&
            reportedAt.toMillis() <= serverNow.toMillis() &&
            reportedAt.toMillis() >= existing.createdAt.toMillis();
        const timestamp = reportedIsSane ? reportedAt : serverNow;
        const author = reported?.voidedBy ?? voidedBy;

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
                userId: author,
                createdAt: timestamp,
            });
        });

        const stockDeltaByProduct = new Map<string, number>();
        for (const item of voidedProductItems) {
            stockDeltaByProduct.set(
                item.productId,
                (stockDeltaByProduct.get(item.productId) ?? 0) + item.quantity,
            );
        }
        productIds.forEach((productId, index) => {
            const delta = stockDeltaByProduct.get(productId) ?? 0;
            const denorm = productDocs[index].data()?.totalStock;
            const baseline = typeof denorm === 'number' ? denorm : 0;
            transaction.update(firestore.collection('products').doc(productId), {
                totalStock: Math.max(0, baseline + delta),
                updatedAt: timestamp,
            });
        });

        // Reversa en el libro de control: cantidad negativa, un renglón por partida
        // controlada. El libro nunca se borra, se contra-asienta.
        for (const item of voidedProductItems) {
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
                userId: author,
                createdAt: timestamp,
            });
        }

        transaction.update(saleRef, { voidedAt: timestamp, voidedBy: author });

        return { ...existing, voidedAt: timestamp, voidedBy: author };
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
            // Anulación hecha sin red y cerrada en el sync: quién la hizo en la
            // caja y cuándo, frente a quién la sincronizó (`userId`).
            ...(reported?.voidedBy || reported?.voidedAt
                ? {
                    offlineVoid: true,
                    reportedVoidedBy: reported?.voidedBy ?? null,
                    reportedVoidedAt: reported?.voidedAt ?? null,
                }
                : {}),
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

/**
 * Comprueba que quien pregunta tenga derecho a ver ESTA venta, aplicando al
 * turno de la venta la misma regla que el resto del módulo de caja: el cajero
 * que lo abrió, o un administrador.
 *
 * Sin esto, `sales:read` (que tiene el mostrador) era una lectura universal por
 * id: cualquier cajero podía leer el detalle —partidas, cliente, forma de pago,
 * totales— de cualquier venta de cualquier compañero, y el ticket completo por
 * `/:id/receipt`. Se separa de `getSale` a propósito para no cambiar las
 * llamadas internas del propio backend, que ya validan por su cuenta.
 */
export const assertCanReadSale = async (
    sale: Sale,
    requesterId: string,
    roleSlug?: string | null,
): Promise<void> => {
    if (!sale.cashSessionId) {
        // Venta sin turno (cobro directo, migración): no hay pertenencia que
        // comprobar, así que solo la ve un administrador.
        assertCanAccessSession({ openedBy: '' }, requesterId, roleSlug);
        return;
    }
    const session = await cashSessionsRepo.getCashSessionById(sale.cashSessionId);
    // Turno inexistente: no se puede acreditar la pertenencia, así que se niega
    // a todo el que no sea administrador en vez de dejarlo pasar.
    assertCanAccessSession({ openedBy: session?.openedBy ?? '' }, requesterId, roleSlug);
};

export const listSales = async (filters: {
    from?: string;
    to?: string;
    cashSessionId?: string;
    includeVoided?: boolean;
    search?: string;
    page?: number;
    limit?: number;
    /** Quién pregunta. Obligatorio para poder filtrar por turno (ver abajo). */
    requesterId?: string;
    requesterRoleSlug?: string | null;
}): Promise<{ items: Sale[]; meta: ListMeta }> => {
    // Filtrar por turno es leer el turno: si no se comprueba la pertenencia, un
    // cajero reconstruye el corte de otro pasando su `cashSessionId` y se salta
    // el `assertCanAccessSession` de `GET /cash-sessions/:id/summary`.
    if (filters.cashSessionId) {
        const session = await cashSessionsRepo.getCashSessionById(filters.cashSessionId);
        if (!session) {
            throw notFound('Turno de caja');
        }
        assertCanAccessSession(session, filters.requesterId ?? '', filters.requesterRoleSlug);
    }

    const { page, limit } = parsePagination(filters.page, filters.limit);
    const { items: sales } = await salesRepo.listSales({
        from: filters.from,
        to: filters.to,
        cashSessionId: filters.cashSessionId,
        includeVoided: filters.includeVoided,
        // Con búsqueda de texto el filtro corre en memoria y necesita ver toda
        // la ventana; sin ella basta traer hasta la profundidad de página pedida.
        maxDocs: filters.search ? undefined : page * limit,
    });

    let filtered = sales;

    if (filters.search) {
        const term = filters.search.toLowerCase();
        filtered = filtered.filter((sale) =>
            sale.folio.toLowerCase().includes(term) ||
            sale.items.some((item) => saleItemName(item).toLowerCase().includes(term)),
        );
    }

    // Sin búsqueda, `filtered.length` es solo lo leído hasta `page * limit` (no
    // el total real de la ventana): correcto para `items`, pero `meta.total`
    // subestima si hay más páginas atrás sin pedir.
    const paginated = paginate(filtered, page, limit);
    return {
        items: paginated.items,
        meta: buildListMeta(page, limit, paginated.total),
    };
};

/** Anulación de ventas: solo el rol de sistema `admin` (no un área de permiso). */
/**
 * Refresca la foto del cobro Point de la venta a partir del aviso de Mercado
 * Pago. La venta ya está registrada y no se toca: lo que cambia es el estado del
 * cobro del otro lado (reembolso, cancelación, contracargo), y sin esto la venta
 * seguiría diciendo `processed` para siempre.
 *
 * Devuelve `null` si la orden no corresponde a ninguna venta —puede ser de un
 * cobro directo, o de un cobro aprobado cuya venta nunca se registró (esa
 * huérfana se reporta en el log: es justo lo que busca la conciliación diaria).
 */
export const syncPointPaymentFromOrder = async (orderId: string): Promise<Sale | null> => {
    const sale = await salesRepo.findSaleByPointOrderId(orderId);
    if (!sale) {
        return null;
    }

    const order = await mercadoPagoService.getOrder(orderId);
    if (sale.pointPayment?.status === order.status) {
        return sale;
    }

    const pointPayment: PointPaymentSnapshot = {
        orderId: order.id,
        paymentId: order.paymentId,
        status: order.status,
        amount: order.amount,
        terminalId: order.terminalId,
        externalReference: order.externalReference,
    };
    await salesRepo.updateSalePointPayment(sale.id, pointPayment);

    if (order.status !== 'processed') {
        // El dinero de una venta cobrada dejó de estar: no se anula sola (eso
        // devolvería stock sin decisión de nadie), pero tiene que verse.
        console.warn('El cobro Point de una venta cambió de estado en Mercado Pago', {
            saleId: sale.id,
            folio: sale.folio,
            orderId,
            status: order.status,
        });
    }

    return { ...sale, pointPayment };
};

/**
 * Anular es **operación normal de mostrador**: el cajero se equivoca de producto
 * o el cliente se arrepiente, y eso pasa con la fila enfrente. Exigir un admin
 * obligaba a escalar cada error y empujaba a la práctica peor —dejar la venta
 * mal registrada y "arreglarla" a mano en el corte—, que es justo lo que un
 * rastro auditable debe evitar.
 *
 * Basta `sales:write` (el permiso con el que se cobra). La protección no es
 * negar la anulación, sino que quede firmada: `voidedAt`, `voidedBy` y el
 * renglón de anulación en el libro de control.
 *
 * La excepción está en `voidSale`: tocar una venta de un turno **ya cerrado**
 * cambia un arqueo firmado, y eso sí sigue siendo de admin.
 */
export const assertCanVoidSale = (user: {
    role: { slug: string };
    permissions: RolePermission[];
}): void => {
    if (!hasPermission(user.permissions, 'sales', 'write', user.role.slug)) {
        throw forbidden('Tu rol no tiene permiso para anular ventas');
    }
};
