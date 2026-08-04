import { Timestamp } from 'firebase-admin/firestore';

export type PermissionArea =
    | 'dashboard'
    | 'users'
    | 'sales'
    | 'categories'
    | 'products'
    | 'suppliers'
    | 'inventory'
    | 'invoices'
    | 'uploads'
    | 'doctor';

export type PermissionLevel = 'read' | 'write';

export interface RolePermission {
    area: PermissionArea;
    level: PermissionLevel;
}

export interface Role {
    id: string;
    name: string;
    slug: string;
    description?: string;
    permissions: RolePermission[];
    isSystem: boolean;
    isActive: boolean;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export type RoleSummary = Pick<Role, 'id' | 'name' | 'slug'>;

export type StockMovementType =
    | 'entry'
    | 'exit_waste'
    | 'exit_expiry'
    | 'sale_adjustment'
    /** Reingreso al lote de origen por devolución parcial de una venta. */
    | 'return_in'
    /**
     * Ajuste por conteo físico. Cantidad **con signo**: positiva si el conteo
     * encontró más de lo registrado, negativa si encontró menos. No usar merma
     * (`exit_waste`) para descuadres: falsea el reporte de mermas.
     */
    | 'adjustment_count';

/** Acciones auditadas en `auditLogs`. Ver `services/audit.service.ts`. */
export type AuditAction =
    | 'product.created'
    | 'product.updated'
    | 'product.price_changed'
    | 'product.deactivated'
    | 'sale.voided'
    | 'sale.discount_override'
    | 'sale.returned'
    | 'cash_session.closed_with_difference'
    | 'inventory.count_adjusted'
    | 'role.created'
    | 'role.updated'
    | 'role.permissions_changed'
    | 'user.role_changed'
    | 'user.status_changed';

export type AuditEntity =
    | 'product'
    | 'sale'
    | 'saleReturn'
    | 'cashSession'
    | 'inventoryCount'
    | 'role'
    | 'user';

export interface AuditLog {
    id: string;
    action: AuditAction;
    entity: AuditEntity;
    entityId: string;
    /** Resumen legible en español; es lo que se lee en una revisión. */
    summary: string;
    userId: string;
    roleSlug: string | null;
    /** Solo los campos que cambiaron, no el documento completo. */
    changes: Record<string, { before: unknown; after: unknown }> | null;
    metadata: Record<string, unknown> | null;
    createdAt: Timestamp;
}

export type ExitReason = 'waste' | 'expiry';

export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'mixed';

export interface Category {
    id: string;
    name: string;
    description?: string;
    isActive: boolean;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface Product {
    id: string;
    name: string;
    sku: string;
    barcode?: string;
    activeIngredient?: string;
    categoryId: string;
    unit: string;
    salePrice: number;
    minStock: number;
    totalStock?: number;
    hasIva: boolean;
    hasIvaZero: boolean;
    hasIeps: boolean;
    concentration?: string;
    /**
     * Grupo COFEPRIS (art. 226 LGS). Determina si la venta exige receta, folio,
     * retención de la receta y registro en el libro de control. Ver
     * `constants/controlled.ts`.
     */
    controlledGroup?: ControlledGroup;
    /**
     * Tasa de IEPS del producto (0.08, 0.265, ...). Requerida cuando `hasIeps`
     * es true; no hay valor por defecto porque la tasa depende del producto.
     */
    iepsRate?: number;
    requiresPrescription?: boolean;
    isActive: boolean;
    suppliers?: string[];
    lastCostPriceBySupplier?: Record<string, number>;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface Customer {
    id: string;
    name: string;
    rfc?: string;
    phone?: string;
    email?: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export type ControlledGroup = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI';

export interface SalePrescription {
    doctorName: string;
    doctorLicense: string;
    folio?: string;
}

/** Movimiento del libro de control de medicamentos controlados. */
export type ControlledLedgerType = 'sale' | 'void' | 'return';

export interface ControlledLedgerEntry {
    id: string;
    type: ControlledLedgerType;
    saleId: string;
    saleFolio: string;
    /** Folio de la devolución cuando `type` es `return`. */
    referenceFolio: string | null;
    productId: string;
    productName: string;
    controlledGroup: ControlledGroup;
    /** Con signo: negativa en `void` y `return` (el producto regresa). */
    quantity: number;
    lotNumbers: string[];
    prescription: SalePrescription | null;
    prescriptionRetained: boolean;
    customerName: string | null;
    userId: string;
    createdAt: Timestamp;
}

export interface SaleBilling {
    rfc: string;
    name: string;
    usoCfdi?: string;
    email?: string;
}

export type CashMovementType = 'deposit' | 'withdrawal' | 'expense';

export interface CashMovement {
    id: string;
    cashSessionId: string;
    type: CashMovementType;
    amount: number;
    reason: string;
    createdBy: string;
    createdAt: Timestamp;
}

export interface ProductWithCategory extends Product {
    category: Category;
}

export interface BulkCreateProductsResult {
    created: Product[];
    errors: Array<{ index: number; sku?: string; message: string }>;
}

export interface BulkCreateEntriesResult {
    created: InventoryEntryWithDetails[];
    errors: Array<{ index: number; message: string }>;
}

export interface Batch {
    id: string;
    productId: string;
    lotNumber: string;
    expiryDate: Timestamp;
    quantity: number;
    costPrice?: number;
    supplierId?: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface BatchWithDetails extends Batch {
    product: ProductWithCategory;
    supplier: Supplier | null;
}

export interface StockMovement {
    id: string;
    type: StockMovementType;
    productId: string;
    batchId: string;
    quantity: number;
    reason?: string;
    referenceId?: string;
    userId: string;
    createdAt: Timestamp;
}

export interface StockMovementWithDetails extends StockMovement {
    product: ProductWithCategory;
}

export interface InventoryEntryItem {
    productId: string;
    lotNumber: string;
    expiryDate: Timestamp;
    quantity: number;
    costPrice?: number;
    batchId: string;
}

export interface InventoryCountItem {
    batchId: string;
    productId: string;
    productName: string;
    lotNumber: string;
    expectedQuantity: number;
    countedQuantity: number;
    /** `countedQuantity - expectedQuantity`; positiva si sobró stock. */
    difference: number;
}

/** Conteo físico (toma de inventario) y el ajuste que generó. */
export interface InventoryCount {
    id: string;
    folio: string;
    items: InventoryCountItem[];
    productIds: string[];
    /** Suma de diferencias absolutas, para ver de un golpe qué tan grande fue. */
    totalDifferenceUnits: number;
    positiveUnits: number;
    negativeUnits: number;
    notes: string | null;
    createdBy: string;
    createdAt: Timestamp;
}

export interface ExpiringBatchAlert {
    batchId: string;
    productId: string;
    productName: string;
    sku: string;
    lotNumber: string;
    expiryDate: Timestamp;
    /** Días hasta la caducidad; negativo si ya venció. */
    daysToExpiry: number;
    quantity: number;
}

export interface StockAlert {
    productId: string;
    productName: string;
    sku: string;
    minStock: number;
    totalStock: number;
}

export interface InventoryAlerts {
    generatedAt: Timestamp;
    /** Lotes ya vencidos con existencia: hay que sacarlos del piso de venta. */
    expired: ExpiringBatchAlert[];
    /** Lotes por vencer agrupados por ventana (30/60/90 días por omisión). */
    expiring: Array<{ windowDays: number; items: ExpiringBatchAlert[] }>;
    lowStock: StockAlert[];
    outOfStock: StockAlert[];
    totals: {
        expiredBatches: number;
        expiredUnits: number;
        expiringBatches: number;
        expiringUnits: number;
        lowStockProducts: number;
        outOfStockProducts: number;
    };
}

export interface Supplier {
    id: string;
    name: string;
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
    notes?: string;
    isActive: boolean;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface Invoice {
    id: string;
    supplierId: string;
    invoiceNumber: string;
    invoiceDate: Timestamp;
    totalAmount: number;
    hasInvoice: boolean;
    storagePath?: string;
    fileName?: string;
    mimeType?: string;
    createdAt: Timestamp;
    createdBy: string;
    updatedAt: Timestamp;
    updatedBy: string;
}

export interface InvoiceWithDetails extends Invoice {
    supplier: Supplier;
    fileUrl?: string;
}

export type InvoiceSummary = Pick<Invoice, 'id' | 'invoiceNumber' | 'invoiceDate'> & {
    supplier: SupplierSummary;
};

export type SupplierSummary = Pick<Supplier, 'id' | 'name'> & {
    lastCostPrice?: number;
};

export interface ProductPurchaseHistoryItem {
    entryId: string;
    supplier: Pick<Supplier, 'id' | 'name'>;
    invoice: InvoiceSummary | null;
    lotNumber: string;
    expiryDate: Timestamp;
    quantity: number;
    costPrice?: number;
    batchId: string;
    createdAt: Timestamp;
}

export interface ProductSaleHistoryItem {
    saleId: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    paymentMethod: PaymentMethod;
    createdAt: Timestamp;
}

export interface ProductInvoiceHistoryItem {
    id: string;
    invoiceNumber: string;
    invoiceDate: Timestamp;
    totalAmount: number;
    hasInvoice: boolean;
    fileUrl?: string;
    supplier: Pick<Supplier, 'id' | 'name'>;
    quantityReceived: number;
    lastReceivedAt: Timestamp;
}

export interface ProductDetail
    extends Omit<ProductWithCategory, 'suppliers' | 'lastCostPriceBySupplier'> {
    stock: number;
    suppliers: SupplierSummary[];
}

export type InventoryEntrySource = 'invoice' | 'direct';

export interface InventoryEntry {
    id: string;
    invoiceId?: string;
    supplierId: string;
    source?: InventoryEntrySource;
    notes?: string;
    productIds?: string[];
    items: InventoryEntryItem[];
    createdAt: Timestamp;
    createdBy: string;
    updatedAt: Timestamp;
    updatedBy: string;
}

export interface InventoryEntryItemWithProduct extends InventoryEntryItem {
    product: ProductWithCategory;
}

export interface InventoryEntryWithDetails extends Omit<InventoryEntry, 'items'> {
    supplier: Supplier;
    invoice: InvoiceSummary | null;
    items: InventoryEntryItemWithProduct[];
}

export type PointOrderStatus =
    | 'created'
    | 'at_terminal'
    | 'processed'
    | 'action_required'
    | 'failed'
    | 'refunded'
    | 'expired'
    | 'canceled';

/**
 * Desglose de impuestos de una partida. Los importes son en pesos y cumplen
 * `base + ivaAmount + iepsAmount === importe cobrado` (ver `utils/taxes.ts`).
 */
export interface SaleItemTaxes {
    base: number;
    ivaRate: number;
    ivaAmount: number;
    iepsRate: number;
    iepsAmount: number;
}

export interface SaleTaxSummary {
    base: number;
    ivaTotal: number;
    iepsTotal: number;
    taxTotal: number;
    /** `base + taxTotal`; coincide con el total cobrado de la venta. */
    total: number;
}

export interface SaleItem {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    subtotal: number;
    /** Parte del descuento a nivel venta prorrateada a esta partida. */
    saleDiscountShare?: number;
    /** Importe realmente cobrado por la partida (impuestos incluidos). */
    netAmount?: number;
    /** Ausente en ventas anteriores al desglose de impuestos. */
    taxes?: SaleItemTaxes;
    /**
     * Costo de la mercancía vendida (COGS) tomado del `costPrice` de los lotes
     * asignados al momento de la venta. `null` cuando algún lote no tenía costo
     * capturado: así el reporte de margen distingue "sin costo" de "costo cero".
     */
    costAmount?: number | null;
    batchAllocations: Array<{
        batchId: string;
        quantity: number;
    }>;
}

export interface PointPaymentSnapshot {
    orderId: string;
    paymentId: string | null;
    status: PointOrderStatus;
    amount: string;
    terminalId: string;
    externalReference: string;
}

export interface Sale {
    id: string;
    folio: string;
    productIds?: string[];
    items: SaleItem[];
    subtotal: number;
    discountTotal: number;
    total: number;
    /** `null` en ventas anteriores al desglose de impuestos. */
    taxSummary?: SaleTaxSummary | null;
    /** Total devuelto por devoluciones parciales; 0 si no hay devoluciones. */
    refundedTotal?: number;
    /** Suma de `costAmount` de las partidas; `null` si alguna no tiene costo. */
    costTotal?: number | null;
    paymentMethod: PaymentMethod;
    amountReceived: number | null;
    change: number | null;
    /**
     * Parte del total pagada en efectivo. En `cash` es el total; en `mixed` es
     * `total - cardAmount`; `null` en tarjeta y transferencia. Es lo que entra al
     * cajón, y no coincide con `amountReceived` cuando hubo cambio.
     */
    cashAmount?: number | null;
    /** Parte del total pagada con tarjeta (monto de la order Point). */
    cardAmount?: number | null;
    cardPaymentReference: string | null;
    pointPayment: PointPaymentSnapshot | null;
    cashSessionId: string | null;
    cashierId: string;
    customerId: string | null;
    customerName: string | null;
    prescription: SalePrescription | null;
    /** El cajero confirmó que la receta se retuvo (grupos I a III). */
    prescriptionRetained?: boolean;
    /** Grupos COFEPRIS presentes en la venta; vacío si nada era controlado. */
    controlledGroups?: ControlledGroup[];
    billing: SaleBilling | null;
    invoiceStatus: 'pending' | null;
    voidedAt: Timestamp | null;
    voidedBy: string | null;
    createdAt: Timestamp;
}

export type RefundMethod = 'cash' | 'card' | 'transfer';

export interface SaleReturnItem {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    /** Importe devuelto por la partida, impuestos incluidos. */
    refundAmount: number;
    taxes: SaleItemTaxes;
    /** Lotes a los que se reingresó el stock (los originales de la venta). */
    batchAllocations: Array<{
        batchId: string;
        quantity: number;
    }>;
}

export interface PointRefundSnapshot {
    orderId: string;
    status: PointOrderStatus;
    amount: number;
}

export interface SaleReturn {
    id: string;
    folio: string;
    saleId: string;
    saleFolio: string;
    items: SaleReturnItem[];
    productIds: string[];
    refundTotal: number;
    refundMethod: RefundMethod;
    taxSummary: SaleTaxSummary;
    pointRefund: PointRefundSnapshot | null;
    reason: string;
    cashSessionId: string;
    createdBy: string;
    createdAt: Timestamp;
}

export interface ReceiptStore {
    name: string;
    rfc: string | null;
    address: string | null;
    phone: string | null;
    footer: string | null;
}

export interface ReceiptTaxLine {
    label: string;
    rate: number;
    amount: number;
}

export interface ReceiptLine {
    productName: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    amount: number;
}

export interface Receipt {
    kind: 'sale' | 'return';
    folio: string;
    issuedAt: Timestamp;
    store: ReceiptStore;
    lines: ReceiptLine[];
    subtotal: number;
    discountTotal: number;
    taxBase: number;
    taxes: ReceiptTaxLine[];
    total: number;
    paymentMethod: PaymentMethod | RefundMethod;
    amountReceived: number | null;
    change: number | null;
    /** Reparto del cobro mixto; `null` cuando no aplica. */
    cashAmount: number | null;
    cardAmount: number | null;
    cashierId: string;
    customerName: string | null;
    prescription: SalePrescription | null;
    /** El cajero confirmó que la receta se retuvo (grupos I a III). */
    prescriptionRetained?: boolean;
    /** Grupos COFEPRIS presentes en la venta; vacío si nada era controlado. */
    controlledGroups?: ControlledGroup[];
    billing: SaleBilling | null;
    /** Aviso legal/nota; en devoluciones incluye el folio de la venta original. */
    notes: string[];
    voided: boolean;
}

export interface CashSession {
    id: string;
    openedBy: string;
    openingAmount: number;
    expectedCashAmount: number | null;
    countedCashAmount: number | null;
    cashDifference: number | null;
    summary?: CashSessionSummary | null;
    closedBy: string | null;
    openedAt: Timestamp;
    closedAt: Timestamp | null;
}

/**
 * Lectura X: corte parcial que NO cierra el turno. Se guarda porque una lectura X
 * es un control (quién miró la caja y cuándo), no solo una impresión.
 */
export interface CashReading {
    id: string;
    folio: string;
    cashSessionId: string;
    summary: CashSessionSummary;
    expectedCashAmount: number;
    createdBy: string;
    createdAt: Timestamp;
}

export interface CashMethodTotals {
    count: number;
    total: number;
}

export interface CashMovementTotals {
    count: number;
    total: number;
}

export interface CashReturnTotals {
    count: number;
    total: number;
    /** Parte devuelta en efectivo, la única que sale del cajón. */
    cashTotal: number;
}

export interface CashSessionSummary {
    salesCount: number;
    voidedCount: number;
    returns?: CashReturnTotals;
    byMethod: {
        cash: CashMethodTotals;
        card: CashMethodTotals;
        transfer: CashMethodTotals;
        mixed: CashMethodTotals;
    };
    movements: {
        deposits: CashMovementTotals;
        withdrawals: CashMovementTotals;
        expenses: CashMovementTotals;
    };
    grandTotal: number;
    cashInDrawer: number;
}

export type PointOperatingMode = 'PDV' | 'STANDALONE' | 'UNDEFINED';

export interface PointDevice {
    id: string;
    posId: string | null;
    storeId: string | null;
    externalPosId: string | null;
    operatingMode: string;
}

export interface PointStore {
    id: string;
    name: string;
    externalId: string | null;
}

export interface PointPos {
    id: string;
    name: string;
    storeId: string;
    externalId: string | null;
    externalStoreId: string | null;
    status: string | null;
}

export interface PointOrder {
    id: string;
    status: PointOrderStatus;
    statusDetail: string | null;
    terminalId: string;
    amount: string;
    externalReference: string;
    paymentId: string | null;
}

export interface UserProfile {
    id: string;
    email: string;
    displayName: string;
    roleId: string;
    isActive: boolean;
    createdAt: Timestamp;
}

export interface UserWithRole extends UserProfile {
    role: RoleSummary;
}

export interface AuthUser {
    uid: string;
    email: string;
    displayName: string;
    roleId: string;
    role: RoleSummary;
    permissions: RolePermission[];
}
