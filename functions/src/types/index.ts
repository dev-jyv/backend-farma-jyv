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
    | 'sale_adjustment';

export type ExitReason = 'waste' | 'expiry';

export type PaymentMethod = 'cash' | 'card' | 'transfer';

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
    hasIva: boolean;
    hasIvaZero: boolean;
    hasIeps: boolean;
    concentration?: string;
    isActive: boolean;
    suppliers?: string[];
    lastCostPriceBySupplier?: Record<string, number>;
    createdAt: Timestamp;
    updatedAt: Timestamp;
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

export interface ProductDetail extends Omit<ProductWithCategory, 'suppliers' | 'lastCostPriceBySupplier'> {
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

export interface SaleItem {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    batchAllocations: Array<{
        batchId: string;
        quantity: number;
    }>;
}

export interface Sale {
    id: string;
    items: SaleItem[];
    subtotal: number;
    total: number;
    paymentMethod: PaymentMethod;
    cashierId: string;
    createdAt: Timestamp;
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
