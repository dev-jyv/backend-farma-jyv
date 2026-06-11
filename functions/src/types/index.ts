import { Timestamp } from 'firebase-admin/firestore';

export type UserRole = 'admin' | 'inventory' | 'cashier';

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
    isActive: boolean;
    suppliers?: string[];
    lastCostPriceBySupplier?: Record<string, number>;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface ProductWithCategory extends Product {
    category: Category;
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

export type SupplierSummary = Pick<Supplier, 'id' | 'name'> & {
    lastCostPrice?: number;
};

export interface ProductDetail extends Omit<ProductWithCategory, 'suppliers' | 'lastCostPriceBySupplier'> {
    stock: number;
    suppliers: SupplierSummary[];
}

export interface InventoryEntry {
    id: string;
    supplierId: string;
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
    role: UserRole;
    isActive: boolean;
    createdAt: Timestamp;
}

export interface AuthUser {
    uid: string;
    email: string;
    role: UserRole;
    displayName: string;
}
