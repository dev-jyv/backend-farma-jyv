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
    | 'doctor'
    | 'patients'
    | 'medicalRecords'
    | 'appointments'
    /**
     * Operación del mostrador: levantar la venta, cobrar con la terminal,
     * abrir/cerrar el turno y dar de alta al cliente en caja.
     *
     * Área propia y no `sales` porque `sales` mezcla dos cosas distintas:
     * vender y administrar lo vendido (anular, devolver, reembolsar en MP,
     * configurar terminales). El cajero necesita lo primero y no debe tener
     * lo segundo — con un área sola, darle de vender le daba también el poder
     * de cancelar y reembolsar sus propias ventas.
     */
    | 'pos'
    /**
     * Cobros con Mercado Pago fuera de una venta. Área propia y no `sales`:
     * mueve dinero sin ticket ni inventario detrás, así que es una atribución de
     * supervisión, no del mostrador —un cajero puede vender sin poder cobrar
     * fuera del ticket.
     */
    | 'directCharges'
    /**
     * Entrada de stock desde la caja: dar de alta mercancía contra una factura ya
     * registrada. Área propia y no `inventory`, porque `inventory:write` abre
     * además conteos, salidas y el libro de control —atribuciones que el
     * mostrador no tiene aunque sí reciba la mercancía.
     */
    | 'stockEntry'
    /**
     * Auditoría de cortes de caja de TODAS las cajas (listado global, aprobar/
     * rechazar ajustes pendientes). Exclusiva de `admin` — el cajero opera su
     * propio turno con `pos:write`, esta área es para supervisión, no para
     * operar el mostrador.
     */
    | 'cashSessions'
    /**
     * Auditoría de gastos de TODAS las cajas (listado global de `CashMovement`
     * con `type: 'expense'`). Exclusiva de `admin` — el cajero registra sus
     * propios gastos con `pos:write`, esta área es solo de supervisión.
     */
    | 'expenses'
    /**
     * Catálogo de servicios de la farmacia (consultas, procedimientos, otros) y
     * el padrón de quienes los realizan. Escritura **exclusiva de `admin`**:
     * el precio y la tasa de comisión de un servicio deciden cuánto se le paga
     * al doctor, así que no es una atribución del mostrador ni de la gerencia.
     *
     * La lectura sí baja hasta el cajero, y se concede **explícitamente** en
     * `cashier` y en `manager`: sin ella la caja no puede sincronizar el
     * catálogo (`GET /pharmacy-services/sync`) ni cobrar un servicio.
     */
    /**
     * Contabilidad (solo admin): estado de resultados, posición financiera y
     * captura de gastos **fuera de caja** (nómina o renta pagadas por
     * transferencia). Área propia y no `expenses`, que es la auditoría de lo que
     * el mostrador gastó de su cajón: aquí se registra dinero que nunca pasó por
     * una caja, y se leen cifras agregadas del negocio completo.
     */
    | 'accounting'
    | 'pharmacyServices';

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
    /**
     * Se incrementa cada vez que cambia `permissions`. El mismo valor se sella
     * en el perfil del usuario y en sus custom claims: el guard solo confía en
     * los claims cuando ambos coinciden, de modo que un token emitido antes del
     * cambio deja de valer al instante en vez de conservar el acceso viejo
     * hasta que expire. `undefined` en documentos anteriores a la migración.
     */
    permissionsVersion?: number;
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
    /** Venta cobrada en caja que el servidor no pudo registrar (stock, producto). */
    | 'sale.unreconciled'
    | 'sale.discount_override'
    | 'sale.returned'
    | 'cash_session.closed_with_difference'
    | 'cash_session.adjustment_reviewed'
    /** Entrada o salida de efectivo hecha por un admin desde la caja de la farmacia. */
    | 'cashMovement.created'
    /** Corrección de un gasto ya registrado (importe, categoría, fecha, motivo). */
    | 'cashMovement.updated'
    /** Abono a una factura de proveedor: sale dinero de la farmacia. */
    | 'supplierPayment.created'
    /** Cancelación de un abono por contrapartida; el original se conserva. */
    | 'supplierPayment.voided'
    /** Corrección del vencimiento o del desglose de impuestos de una factura. */
    | 'invoice.updated'
    | 'fixedAsset.created'
    | 'fixedAsset.updated'
    | 'fixedAsset.disposed'
    | 'equityMovement.created'
    | 'accruedExpense.created'
    /** Pago de un gasto devengado: mueve efectivo, no vuelve a pegar en resultados. */
    | 'accruedExpense.paid'
    | 'bankAccount.created'
    | 'bankAccount.updated'
    /** Movimiento bancario capturado a mano o traspaso entre caja y banco. */
    | 'bankMovement.created'
    | 'bankMovement.reconciled'
    /** Cambio de saldos de apertura o de la fecha de arranque contable. */
    | 'accountingSettings.updated'
    /** Cierre o reapertura de periodos contables. */
    | 'accountingPeriod.closed'
    | 'inventory.count_adjusted'
    | 'role.created'
    | 'role.updated'
    | 'role.permissions_changed'
    | 'user.role_changed'
    | 'user.status_changed'
    /**
     * Expediente clínico: la NOM-004 exige que el expediente sea íntegro y
     * rastreable, así que toda edición de una nota ya guardada se audita
     * (a diferencia de las altas rutinarias del resto del sistema).
     */
    | 'medicalRecord.updated'
    | 'medicalRecord.attachment_added'
    | 'appointment.cancelled'
    | 'appointment.rescheduled'
    /** Cobro con terminal fuera de una venta: mueve dinero sin ticket que lo respalde. */
    | 'directCharge.created'
    | 'directCharge.canceled';

export type AuditEntity =
    | 'product'
    | 'sale'
    | 'saleReturn'
    | 'cashSession'
    | 'cashMovement'
    | 'supplierPayment'
    | 'invoice'
    | 'fixedAsset'
    | 'equityMovement'
    | 'accruedExpense'
    | 'bankAccount'
    | 'bankMovement'
    | 'accountingSettings'
    | 'inventoryCount'
    | 'role'
    | 'user'
    | 'medicalRecord'
    | 'appointment'
    | 'directCharge'
    | 'unreconciledSale';

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

/** Solo aplica cuando `CashMovement.type === 'expense'`. */
export type ExpenseCategory =
    | 'salary' | 'food' | 'rent' | 'contingency' | 'electricity'
    | 'supplies' | 'supplier' | 'other';

/**
 * Cómo se pagó un gasto. Solo `cash` sale del cajón: un gasto pagado por
 * transferencia o con tarjeta empresarial es gasto del periodo pero **no**
 * movimiento de efectivo, así que no puede descontarse del corte ni de la caja
 * de la farmacia. Los movimientos anteriores a este campo se leen como `cash`,
 * que es lo que eran: todos se capturaban desde el POS.
 */
export type ExpensePaymentMethod = 'cash' | 'transfer' | 'card';

export interface CashMovement {
    id: string;
    /**
     * `null` en los movimientos de la caja de la farmacia: el admin puede sacar
     * o meter efectivo sin turno abierto, y esos no entran a ningún corte.
     */
    cashSessionId: string | null;
    type: CashMovementType;
    amount: number;
    reason: string;
    /** Solo poblado cuando `type === 'expense'`. */
    category?: ExpenseCategory | null;
    /** Obligatoria cuando `category` es `supplies`/`supplier`/`other`. */
    description?: string | null;
    createdBy: string;
    /**
     * Nombre o correo de quien lo registró, denormalizado. El POS solo conoce el
     * `uid`, y la auditoría la lee un admin que no tiene forma de traducirlo: sin
     * esto la pantalla mostraba el uid crudo.
     */
    createdByLabel?: string | null;
    /**
     * Cómo se pagó. Ausente en los movimientos anteriores a contabilidad; se lee
     * como `cash`. Ver `ExpensePaymentMethod`: solo `cash` mueve el cajón.
     */
    paymentMethod?: ExpensePaymentMethod | null;
    /**
     * Cuenta de la que salió el dinero, cuando no salió del cajón. Es lo que
     * permite que el saldo bancario se calcule sin duplicar el gasto en una
     * segunda colección. En un traspaso caja→banco marca la cuenta destino.
     */
    bankAccountId?: string | null;
    /**
     * Gasto devengado que este movimiento liquida. Va en un `withdrawal` y no en
     * un `expense` a propósito: el gasto ya pegó en resultados al devengarse, y
     * registrarlo otra vez como gasto lo contaría dos veces.
     */
    accruedExpenseId?: string | null;
    /**
     * Fecha a la que **pertenece** el gasto, que no siempre es la de captura: la
     * renta de marzo puede registrarse en abril, y cargarla al mes equivocado
     * deforma los dos estados de resultados. `createdAt` queda como el rastro de
     * cuándo se tecleó y nunca se toca. Ausente en los movimientos anteriores a
     * contabilidad, donde captura y ocurrencia eran el mismo instante.
     */
    occurredAt?: Timestamp | null;
    /** Solo si el gasto se corrigió después de registrarse. */
    updatedAt?: Timestamp | null;
    createdAt: Timestamp;
}

/**
 * Cuenta bancaria de la farmacia. Existe para que "bancos" deje de ser una
 * estimación: mientras el saldo se infería del flujo conocido, un traspaso entre
 * caja y banco se veía por un solo lado y el balance no cerraba nunca.
 */
export interface BankAccount {
    id: string;
    name: string;
    bank: string;
    /** Últimos cuatro dígitos; el número completo no se guarda. */
    last4?: string | null;
    openingBalance: number;
    /** Fecha del saldo inicial: antes de ella la cuenta no aporta movimientos. */
    openingDate: Timestamp;
    isActive: boolean;
    createdBy: string;
    createdAt: Timestamp;
    updatedBy?: string | null;
    updatedAt?: Timestamp | null;
}

export type BankMovementDirection = 'in' | 'out';

/**
 * De dónde sale el movimiento. `manual` es la captura suelta (un depósito de la
 * terminal, un cargo del banco) y `transfer` es el traspaso entre caja y banco,
 * que siempre viaja con su movimiento de efectivo enfrente.
 *
 * Los gastos y los abonos a proveedor **no** generan documento aquí: llevan
 * `bankAccountId` en su propio registro y el saldo los suma desde ahí. Guardar
 * además un movimiento bancario sería el mismo hecho escrito dos veces, y dos
 * copias del mismo hecho terminan discrepando.
 */
export type BankMovementOrigin = 'manual' | 'transfer';

export interface BankMovement {
    id: string;
    accountId: string;
    direction: BankMovementDirection;
    amount: number;
    occurredAt: Timestamp;
    concept: string;
    reference?: string | null;
    origin: BankMovementOrigin;
    /** Movimiento de efectivo que acompaña al traspaso. */
    cashMovementId?: string | null;
    /** Marcado contra el estado de cuenta del banco. */
    reconciledAt?: Timestamp | null;
    reconciledBy?: string | null;
    createdBy: string;
    createdByLabel?: string | null;
    createdAt: Timestamp;
}

/**
 * Gasto **devengado**: ya ocurrió y todavía no se paga (la renta del mes que se
 * liquida el día 5, la luz que llega con recibo a 15 días).
 *
 * Existe porque el estado de resultados venía siendo mixto: ingresos y costo
 * devengados, gastos a base de efectivo. Un gasto causado y no pagado no tenía
 * dónde vivir, así que el mes salía con la utilidad inflada y el pasivo corto.
 *
 * El gasto pega en resultados en `accruedAt`; su pago después solo mueve
 * efectivo —se registra como `withdrawal`, no como `expense`— para que el mismo
 * gasto no se cuente dos veces.
 */
export interface AccruedExpense {
    id: string;
    category: ExpenseCategory;
    concept: string;
    description?: string | null;
    amount: number;
    /** Fecha de **devengo**: a qué periodo pertenece el gasto. */
    accruedAt: Timestamp;
    /** Vencimiento pactado; ausente si no hay plazo. */
    dueDate?: Timestamp | null;
    /** Σ de lo pagado. El saldo y el estado se derivan de él. */
    paidTotal: number;
    lastPaymentAt?: Timestamp | null;
    createdBy: string;
    createdByLabel?: string | null;
    createdAt: Timestamp;
    updatedBy?: string | null;
    updatedAt?: Timestamp | null;
}

export type FixedAssetCategory =
    | 'furniture'
    | 'equipment'
    | 'computing'
    | 'vehicle'
    | 'improvements'
    | 'other';

/**
 * Bien de activo fijo. La depreciación **no se guarda**: se calcula al vuelo
 * para la fecha que se pida. Guardarla obligaría a un proceso mensual que, el
 * mes que no corra, deja el estado de resultados mudo sin que nadie se entere.
 */
export interface FixedAsset {
    id: string;
    name: string;
    category: FixedAssetCategory;
    acquiredAt: Timestamp;
    /** Costo de adquisición; la base depreciable es `cost - salvageValue`. */
    cost: number;
    usefulLifeMonths: number;
    /** Valor de rescate al final de la vida útil; 0 en casi todo. */
    salvageValue: number;
    notes?: string | null;
    /** Baja del bien: deja de depreciarse a partir de esta fecha. */
    disposedAt?: Timestamp | null;
    disposalAmount?: number | null;
    disposalReason?: string | null;
    createdBy: string;
    createdAt: Timestamp;
    updatedBy?: string | null;
    updatedAt?: Timestamp | null;
}

export type EquityMovementType = 'contribution' | 'withdrawal';

/**
 * Aportación o retiro de socios. Solo alta y consulta: una cifra equivocada se
 * corrige con el movimiento contrario, no editando el original — es la misma
 * regla que ya siguen los abonos a proveedor.
 */
export interface EquityMovement {
    id: string;
    type: EquityMovementType;
    amount: number;
    occurredAt: Timestamp;
    partner: string;
    note?: string | null;
    createdBy: string;
    createdByLabel?: string | null;
    createdAt: Timestamp;
}

/**
 * Saldos de apertura a la fecha de arranque contable. Sin ellos el balance no
 * cierra ni con todos los módulos: el sistema solo conoce lo ocurrido desde que
 * se instaló, y todo lo anterior tiene que entrar por aquí en un solo renglón
 * por rubro.
 */
export interface OpeningBalances {
    cash: number;
    bank: number;
    inventory: number;
    payables: number;
    fixedAssets: number;
    accumulatedDepreciation: number;
    equityContributions: number;
    retainedEarnings: number;
}

/**
 * Configuración contable; documento único. Vive en Firestore y no en una
 * constante porque la fecha de arranque y los saldos los captura el admin, y
 * cambiarlos no puede exigir un despliegue.
 */
export interface AccountingSettings {
    /** Fecha de arranque contable: antes de ella solo existen los saldos de apertura. */
    startDate: Timestamp | null;
    openingBalances: OpeningBalances;
    /**
     * Periodos cerrados: no se admite movimiento con fecha **menor o igual** a
     * esta. Sin el cierre, alguien captura un gasto en un mes ya reportado y el
     * estado de resultados que se firmó cambia de cifra después.
     */
    closedThrough: Timestamp | null;
    updatedBy?: string | null;
    updatedAt?: Timestamp | null;
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
    /**
     * Agotados **con mínimo definido**: falta mercancía que alguien decidió que
     * no puede faltar. Es la lista de pedido, ordenada por el mínimo (lo que más
     * se necesita primero).
     */
    outOfStock: StockAlert[];
    /**
     * Productos en cero **sin mínimo definido**.
     *
     * No son un faltante: nadie declaró que debieran estar en existencia. Van
     * aparte porque mezclarlos con `outOfStock` convertía la alerta en un
     * volcado del catálogo —211 renglones en producción contra un puñado de
     * faltantes reales— y una alerta que no se puede leer no se lee. Lo que
     * piden es depuración de catálogo: asignarles mínimo o darlos de baja.
     */
    unstocked: StockAlert[];
    totals: {
        expiredBatches: number;
        expiredUnits: number;
        expiringBatches: number;
        expiringUnits: number;
        lowStockProducts: number;
        /** Solo los agotados con mínimo definido. */
        outOfStockProducts: number;
        unstockedProducts: number;
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

/**
 * Desglose de impuestos de una factura de compra. `subtotal + ivaAmount +
 * iepsAmount` tiene que dar `totalAmount`: sin esa igualdad el IVA acreditable
 * se calcularía sobre una base que no es la de la factura.
 *
 * Opcional en el documento: las facturas anteriores a contabilidad solo guardan
 * el total, y el estado de resultados reporta cuántas están así en vez de
 * inventarles un impuesto.
 */
export interface InvoiceTaxBreakdown {
    subtotal: number;
    ivaAmount: number;
    iepsAmount: number;
}

/**
 * Estado de liquidación de una factura de proveedor. **Derivado**, nunca
 * guardado: el saldo es la única fuente, y un estado almacenado se desincroniza
 * del primer abono que falle a medias.
 *
 * `legacy` son las facturas anteriores a cuentas por pagar (sin `paidTotal`): se
 * dan por saldadas. Tratarlas como pendientes haría aparecer, el día del
 * despliegue, una deuda falsa del tamaño de todo lo comprado en la historia del
 * sistema.
 */
export type InvoicePaymentStatus = 'legacy' | 'pending' | 'partial' | 'paid';

export interface SupplierPayment {
    id: string;
    invoiceId: string;
    supplierId: string;
    /**
     * **Negativo** en una contrapartida: cancelar un abono no lo borra, le pone
     * enfrente su reverso. Borrarlo dejaría una factura cuyo saldo cambió sin
     * que nada explique por qué, que es justo lo que la bitácora evita.
     */
    amount: number;
    /** Mismo juego que los gastos: solo `cash` sale del cajón. */
    paymentMethod: ExpensePaymentMethod;
    /** Fecha del pago, que puede no ser la de captura. */
    paidAt: Timestamp;
    reference?: string | null;
    notes?: string | null;
    /** Cuenta de la que salió el pago, cuando no fue en efectivo. */
    bankAccountId?: string | null;
    createdBy: string;
    createdByLabel?: string | null;
    createdAt: Timestamp;
    /** Id del abono que esta contrapartida cancela; solo en los reversos. */
    voidsPaymentId?: string | null;
    /** Cuándo se canceló este abono; el reverso apunta a él con `voidsPaymentId`. */
    voidedAt?: Timestamp | null;
    voidedBy?: string | null;
    voidReason?: string | null;
}

export interface Invoice {
    id: string;
    supplierId: string;
    invoiceNumber: string;
    invoiceDate: Timestamp;
    /** Vencimiento pactado con el proveedor; ausente = sin plazo registrado. */
    dueDate?: Timestamp | null;
    totalAmount: number;
    /** Desglose de impuestos; ausente en las facturas anteriores a contabilidad. */
    taxes?: InvoiceTaxBreakdown | null;
    /**
     * Σ de los abonos. Se denormaliza **dentro de la transacción** que registra
     * el abono, así que no puede quedar a medias; el estado y el saldo se
     * derivan de él. Ausente = factura anterior a cuentas por pagar (`legacy`).
     */
    paidTotal?: number;
    lastPaymentAt?: Timestamp | null;
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
    /** Derivados del saldo; ver `InvoicePaymentStatus`. */
    paymentStatus: InvoicePaymentStatus;
    balance: number;
    /** Vencida: tiene saldo y su `dueDate` ya pasó. */
    isOverdue: boolean;
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

/**
 * Lo que toda partida de venta tiene, venda mercancía o servicio: cantidad,
 * precio, descuento e impuestos. Lo específico de cada naturaleza vive en
 * `SaleProductItem` / `SaleServiceItem`.
 */
export interface SaleItemCommon {
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
}

/** Partida de mercancía: descuenta lotes y tiene costo de venta (COGS). */
export interface SaleProductItem extends SaleItemCommon {
    /**
     * Discriminante de la unión. Los documentos anteriores a los servicios no lo
     * tienen: al leer Firestore se resuelve con `saleItemKind(item)`
     * (`kind ?? 'product'`), nunca leyendo `item.kind` a secas.
     */
    kind: 'product';
    productId: string;
    productName: string;
    /**
     * Precio de catálogo al registrar la venta, guardado **solo cuando difiere**
     * del cobrado (`unitPrice`). Una venta sin conexión se tarifa con el precio
     * del momento; si el catálogo cambió entre medias, esto deja la divergencia
     * auditable en vez de invisible.
     */
    catalogUnitPrice?: number;
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

/**
 * Partida de servicio (consulta, procedimiento, otro): no toca inventario y su
 * comisión se acredita a un `ServiceProvider` del catálogo propio —un doctor que
 * **no** es usuario del sistema—, por eso `providerId` es un id de
 * `serviceProviders` y no un uid.
 */
export interface SaleServiceItem extends SaleItemCommon {
    /**
     * Precio del catálogo al registrar, cuando difiere del cobrado. Misma señal
     * auditable que en mercancía: deja rastro de que el POS tarifó distinto
     * (precio cambiado entre el cobro y el sync, o payload manipulado).
     */
    catalogUnitPrice?: number;
    kind: 'service';
    serviceId: string;
    serviceName: string;
    /** `null` cuando el servicio no exige quién lo realizó (`requiresPerformer: false`). */
    providerId: string | null;
    providerName: string | null;
    /** Porcentaje (0..100) congelado al cobrar; el catálogo puede cambiar después. */
    commissionRate: number;
    /** Importe de la comisión en pesos, ya calculado con `commissionRate`. */
    commissionAmount: number;
}

export type SaleLineItem = SaleProductItem | SaleServiceItem;

/**
 * Alias histórico de la partida de mercancía. Se conserva para no renombrar de
 * golpe cada uso; el flujo de venta con servicios (fase 2) migra a
 * `SaleLineItem`.
 */
export type SaleItem = SaleProductItem;

/**
 * Naturaleza de una partida leída de Firestore. Las ventas anteriores a los
 * servicios no guardaron `kind`: todas eran mercancía.
 */
export const saleItemKind = (
    item: { kind?: SaleLineItem['kind'] },
): SaleLineItem['kind'] => item.kind ?? 'product';

/** Estrecha una partida leída de Firestore a la variante de mercancía. */
export const isSaleProductItem = (item: SaleLineItem): item is SaleProductItem =>
    saleItemKind(item) === 'product';

/** Estrecha una partida leída de Firestore a la variante de servicio. */
export const isSaleServiceItem = (item: SaleLineItem): item is SaleServiceItem =>
    saleItemKind(item) === 'service';

/**
 * Nombre imprimible de la partida, sea mercancía o servicio. Existe porque el
 * ticket y la búsqueda de ventas no tienen por qué saber de qué naturaleza es
 * cada renglón, pero el campo se llama distinto en cada variante.
 */
export const saleItemName = (item: SaleLineItem): string =>
    isSaleServiceItem(item) ? item.serviceName : item.productName;

export interface PointPaymentSnapshot {
    orderId: string;
    paymentId: string | null;
    status: PointOrderStatus;
    amount: string;
    terminalId: string;
    externalReference: string;
}

/**
 * Venta **cobrada en la caja** que el backend no pudo registrar como venta: el
 * stock remoto no alcanzaba, el producto no existe allá, o el turno ya estaba
 * cerrado. El dinero entró y el movimiento no puede perderse, pero registrarla
 * en `sales` descuadraría el inventario, así que vive aquí hasta que alguien la
 * concilie a mano.
 */
export interface UnreconciledSale {
    id: string;
    /** Id de la venta en el SQLite de la caja: la liga entre las dos bases. */
    localId: string;
    /** Folio provisional con el que se imprimió el ticket (`PENDIENTE-…`). */
    localFolio: string | null;
    /** Motivo con el que el backend rechazó la venta. */
    reason: string;
    total: number;
    /** `CreateSalePayload` tal como se intentó registrar. */
    payload: Record<string, unknown>;
    cashierId: string;
    cashSessionId: string | null;
    /** Instante del cobro en la caja, no el del intento de sincronización. */
    occurredAt: Timestamp | null;
    resolvedAt: Timestamp | null;
    resolvedBy: string | null;
    createdAt: Timestamp;
}

export interface Sale {
    id: string;
    folio: string;
    /**
     * **Solo mercancía**, nunca ids de servicio: los reportes resuelven cada id
     * contra `products`, así que un id de servicio aquí los revienta.
     */
    productIds?: string[];
    /**
     * Mercancía y servicios en la misma venta. Las partidas anteriores a los
     * servicios no traen `kind`: hay que estrecharlas con `isSaleProductItem` /
     * `isSaleServiceItem`, nunca leyendo `item.kind` a secas.
     */
    items: SaleLineItem[];
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
    /**
     * Denormalizados del cobro de servicios. **Los calcula el servidor**: el
     * payload propone las partidas, el backend decide los totales. Ausentes en
     * las ventas anteriores a los servicios, que se leen como 100 % farmacia.
     */
    hasServices?: boolean;
    /** Ids de servicio de la venta; para `array-contains`. */
    serviceIds?: string[];
    /** Doctores con comisión en la venta; para `array-contains`. */
    providerIds?: string[];
    commissionTotal?: number;
    /** Comisión por doctor, ya sumada por partida. */
    commissionByProvider?: Record<string, number>;
    /** Σ del importe neto de las partidas de mercancía; `total` si no hubo servicios. */
    pharmacyTotal?: number;
    /** Σ del importe neto de las partidas de servicio; 0 si no hubo. */
    servicesTotal?: number;
    /**
     * Reparto del efectivo entre las dos ramas, con la regla **servicios
     * primero**: el efectivo cubre los servicios y lo que sobra es de farmacia.
     * Siempre suman `cashAmount ?? 0`.
     */
    pharmacyCashAmount?: number;
    servicesCashAmount?: number;
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

export type CashAdjustmentStatus = 'pending' | 'approved' | 'rejected';

export interface CashSession {
    id: string;
    openedBy: string;
    openingAmount: number;
    /** Efectivo esperado **de farmacia**; el de servicios va aparte. */
    expectedCashAmount: number | null;
    /**
     * Efectivo esperado de la rama de servicios. El cajón es uno solo: el
     * conteo (`countedCashAmount`) y la diferencia se calculan contra la **suma**
     * de los dos esperados. Ausente en los turnos anteriores a los servicios.
     */
    expectedServicesCashAmount?: number | null;
    countedCashAmount: number | null;
    cashDifference: number | null;
    summary?: CashSessionSummary | null;
    closedBy: string | null;
    openedAt: Timestamp;
    closedAt: Timestamp | null;
    /** `true` si `|cashDifference| >= 0.01` al cerrar y el cierre no fue automático. */
    hasPendingAdjustment?: boolean;
    adjustmentStatus?: CashAdjustmentStatus | null;
    adjustmentReviewedBy?: string | null;
    adjustmentReviewedAt?: Timestamp | null;
    adjustmentNote?: string | null;
    /**
     * `true` si el turno se cerró solo por expiración de sesión (24:00 CDMX),
     * sin cajero presente.
     */
    autoClosedByExpiry?: boolean;
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

/**
 * Corte de la rama de servicios, **hermano** del corte de farmacia y no unos
 * campos sueltos: el cajón es uno solo, pero la farmacia quiere ver el dinero de
 * consultas y procedimientos aparte del de mercancía.
 *
 * Ausente en los cortes anteriores a los servicios y en los turnos donde no se
 * cobró ninguno.
 */
export interface CashServicesTotals {
    /** Ventas **con servicios** del turno (no partidas). */
    count: number;
    voidedCount: number;
    byMethod: {
        cash: CashMethodTotals;
        card: CashMethodTotals;
        transfer: CashMethodTotals;
        mixed: CashMethodTotals;
    };
    /** Σ del importe neto de las partidas de servicio. */
    total: number;
    commissionTotal: number;
    /** Efectivo de servicios que quedó en el cajón (abre en 0: el fondo es de farmacia). */
    cashInDrawer: number;
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
    /** Efectivo esperado **de farmacia** (fondo inicial + ventas − movimientos − devoluciones). */
    cashInDrawer: number;
    /** Corte de servicios; solo presente si el turno cobró alguno. */
    services?: CashServicesTotals;
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

/* ── Cobro directo con tarjeta (sin venta) ─────────────────────────────── */

/**
 * Estado del cobro directo. Es un estado propio, no el de Mercado Pago: la
 * order Point tiene más estados de los que le importan a la caja, y el cobro
 * puede quedar `approved` aunque la order caduque después.
 */
export type DirectChargeStatus = 'pending' | 'approved' | 'failed' | 'canceled';

/** Cómo se cobró: terminal física (Point) o link de pago de Mercado Pago. */
export type DirectChargeChannel = 'point' | 'online';

/**
 * Cobro en línea (Checkout Pro). `initPoint` es el link que se comparte con el
 * cliente; `expiresAt` lo cierra para que un link viejo no cobre de nuevo.
 */
export interface OnlineChargeSnapshot {
    preferenceId: string;
    initPoint: string;
    sandboxInitPoint: string | null;
    paymentId: string | null;
    /** Estado crudo del pago en Mercado Pago (`approved`, `rejected`, …). */
    paymentStatus: string | null;
    externalReference: string;
    expiresAt: string | null;
}

/**
 * Cobro que NO corresponde a una venta de mostrador (servicio, abono, cobro de
 * terceros), por terminal Point o por link de pago. Vive en su propia colección
 * `directCharges`: no toca inventario, ni el corte de caja, ni los reportes de
 * ventas.
 */
export interface DirectCharge {
    id: string;
    folio: string;
    amount: number;
    concept: string;
    channel: DirectChargeChannel;
    status: DirectChargeStatus;
    /** Detalle del rechazo tal como lo reporta Mercado Pago. */
    statusDetail: string | null;
    /** Presente solo en cobros por terminal. */
    point: PointPaymentSnapshot | null;
    /** Presente solo en cobros en línea. */
    online: OnlineChargeSnapshot | null;
    cashierId: string;
    roleSlug: string | null;
    canceledBy: string | null;
    canceledAt: Timestamp | null;
    approvedAt: Timestamp | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface UserProfile {
    id: string;
    email: string;
    displayName: string;
    roleId: string;
    /**
     * Copia de `Role.permissionsVersion` vigente cuando se sincronizaron los
     * claims de este usuario. El guard ya lee el perfil en cada request, así
     * que comparar contra el claim no cuesta lecturas extra.
     */
    permissionsVersion?: number;
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

/* ── Consultorio: pacientes, expediente clínico y agenda ───────────────── */

/**
 * Quién ejecuta la acción en el consultorio. Se propaga desde el controller
 * (`req.authUser`) porque la nota clínica y la cita guardan el nombre del doctor
 * denormalizado, no solo su uid.
 */
export interface ClinicActor {
    userId: string;
    displayName: string;
    roleSlug?: string | null;
}

export type PatientSex = 'male' | 'female' | 'other';

export type BloodType = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';

export interface PatientEmergencyContact {
    name: string;
    phone: string;
    relationship?: string;
}

export interface Patient {
    id: string;
    /** Folio de expediente visible al paciente: `EXP-000001`. */
    folio: string;
    firstName: string;
    lastName: string;
    /** `firstName lastName`, denormalizado para búsqueda y para pintar listas. */
    fullName: string;
    birthDate: Timestamp;
    sex: PatientSex;
    phone?: string;
    email?: string;
    /** CURP: identificador oficial mexicano, único cuando está presente. */
    curp?: string;
    bloodType?: BloodType;
    allergies: string[];
    chronicConditions: string[];
    /** Enlace opcional al cliente de la farmacia (`customers`) para facturación. */
    customerId?: string;
    address?: string;
    emergencyContact?: PatientEmergencyContact;
    notes?: string;
    isActive: boolean;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export type MedicalRecordType =
    | 'consultation'
    | 'followUp'
    | 'labResult'
    | 'imaging'
    | 'prescription'
    | 'note';

/** Signos vitales de la consulta. Todos opcionales: no toda nota los toma. */
export interface Vitals {
    heightCm?: number;
    weightKg?: number;
    temperatureC?: number;
    systolic?: number;
    diastolic?: number;
    heartRate?: number;
    respiratoryRate?: number;
    oxygenSaturation?: number;
    /** Calculado por el servidor a partir de peso y talla; no se acepta del cliente. */
    bmi?: number;
}

export interface MedicalRecordAttachment {
    id: string;
    storagePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedBy: string;
    uploadedAt: Timestamp;
}

export interface MedicalRecord {
    id: string;
    patientId: string;
    /** Denormalizado para listar sin resolver el paciente en cada fila. */
    patientName: string;
    doctorId: string;
    doctorName: string;
    appointmentId?: string;
    type: MedicalRecordType;
    visitedAt: Timestamp;
    chiefComplaint?: string;
    vitals?: Vitals;
    diagnosis?: string;
    treatment?: string;
    notes?: string;
    attachments: MedicalRecordAttachment[];
    createdBy: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export type AppointmentStatus =
    | 'scheduled'
    | 'confirmed'
    | 'in_progress'
    | 'completed'
    | 'cancelled'
    | 'no_show';

export interface Appointment {
    id: string;
    patientId: string;
    patientName: string;
    doctorId: string;
    doctorName: string;
    startAt: Timestamp;
    endAt: Timestamp;
    durationMinutes: number;
    reason?: string;
    status: AppointmentStatus;
    notes?: string;
    cancelReason?: string;
    /** Nota del expediente generada al cerrar la cita, si existe. */
    medicalRecordId?: string;
    createdBy: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

/** Naturaleza del servicio que cobra la farmacia. */
export type ServiceType = 'consultation' | 'procedure' | 'other';

/**
 * Régimen de IVA del servicio. A diferencia del producto —que lo modela con dos
 * banderas (`hasIva`/`hasIvaZero`) que pueden contradecirse— aquí es un solo
 * valor: exento (sin IVA y sin derecho a acreditamiento, el caso de la consulta
 * médica), tasa 0% o tasa general 16%.
 */
export type ServiceTaxMode = 'exempt' | 'zero' | 'iva16';

/**
 * Servicio que la farmacia cobra en la misma venta que la mercancía: consulta,
 * procedimiento u otro concepto.
 *
 * No tiene `stock`, `minStock`, `controlledGroup` ni `costPrice` **a propósito**:
 * un servicio no se recibe en una entrada de inventario ni se agota, y su corte
 * se lleva aparte del de mercancía.
 */
export interface PharmacyService {
    id: string;
    /** Clave corta con la que la caja lo busca; única en la colección. */
    code: string;
    name: string;
    description?: string;
    serviceType: ServiceType;
    /** Precio al público con impuesto **incluido**, igual criterio que `Product.salePrice`. */
    price: number;
    taxMode: ServiceTaxMode;
    hasIeps: boolean;
    /** Tasa de IEPS como fracción (0.08 = 8%), no como porcentaje. */
    iepsRate?: number;
    /** Porcentaje 0..100 que se le acredita a quien realiza el servicio; 0 = sin comisión. */
    commissionRate: number;
    /** `true` ⇒ al cobrarlo es obligatorio elegir el `ServiceProvider` que lo realizó. */
    requiresPerformer: boolean;
    isActive: boolean;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy: string;
}

/**
 * Quien realiza un servicio y cobra la comisión: el "doctor" del catálogo.
 *
 * **No es un usuario del sistema**: no tiene uid, ni rol, ni acceso. La farmacia
 * le acredita comisiones sin darle de alta en Firebase Auth, que es justo lo que
 * hacía inviable reutilizar `users` para esto.
 */
export interface ServiceProvider {
    id: string;
    name: string;
    /** Cédula profesional mexicana: 7 u 8 dígitos, la misma validación que la receta. */
    license?: string;
    /** Porcentaje 0..100 por omisión; **el servicio manda** si define el suyo. */
    defaultCommissionRate?: number;
    isActive: boolean;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}
