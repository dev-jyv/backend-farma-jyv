import { z } from 'zod';

const paginationFields = {
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
};

const permissionAreaSchema = z.enum([
    'dashboard',
    'users',
    'sales',
    'categories',
    'products',
    'suppliers',
    'inventory',
    'invoices',
    'uploads',
    'doctor',
]);

const rolePermissionSchema = z.object({
    area: permissionAreaSchema,
    level: z.enum(['read', 'write']),
});

export const registerStaffSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().min(2),
    roleId: z.string().min(1),
});

export const updateUserSchema = z.object({
    displayName: z.string().min(2).optional(),
    roleId: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
});

export const createRoleSchema = z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().optional(),
    permissions: z.array(rolePermissionSchema).min(1),
});

export const updateRoleSchema = z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    permissions: z.array(rolePermissionSchema).min(1).optional(),
    isActive: z.boolean().optional(),
});

export const listRolesQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const listUsersQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    roleId: z.string().min(1).optional(),
    ...paginationFields,
});

export const listCategoriesQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const createCategorySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
});

export const updateCategorySchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
});

export const createProductSchema = z
    .object({
        name: z.string().min(1),
        sku: z.string().min(1),
        barcode: z.string().optional(),
        activeIngredient: z.string().optional(),
        categoryId: z.string().min(1),
        unit: z.string().min(1),
        salePrice: z.number().nonnegative(),
        minStock: z.number().int().nonnegative(),
        hasIva: z.boolean(),
        hasIvaZero: z.boolean(),
        hasIeps: z.boolean(),
        concentration: z.string().optional(),
    })
    .refine((data) => !(data.hasIva && data.hasIvaZero), {
        message: 'Un producto no puede tener IVA e IVA cero al mismo tiempo',
        path: ['hasIvaZero'],
    });

export const updateProductSchema = z.object({
    name: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    barcode: z.string().optional(),
    activeIngredient: z.string().optional(),
    categoryId: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    salePrice: z.number().nonnegative().optional(),
    minStock: z.number().int().nonnegative().optional(),
    hasIva: z.boolean().optional(),
    hasIvaZero: z.boolean().optional(),
    hasIeps: z.boolean().optional(),
    concentration: z.string().optional(),
    isActive: z.boolean().optional(),
});

export const bulkCreateProductsSchema = z.object({
    items: z.array(createProductSchema).min(1).max(500),
});

export const updateProductPriceItemSchema = z.object({
    productId: z.string().min(1),
    salePrice: z.number().nonnegative(),
});

export const updateProductPricesSchema = z.object({
    items: z.array(updateProductPriceItemSchema).min(1),
});

export const inventoryEntryProductSchema = z.object({
    productId: z.string().min(1),
    expiryDate: z.string().min(1),
    quantity: z.number().positive(),
    lotNumber: z.string().min(1).optional(),
    costPrice: z.number().nonnegative().optional(),
});

export const bulkEntryGroupSchema = z.object({
    invoiceId: z.string().min(1).optional(),
    supplierId: z.string().min(1).optional(),
    notes: z.string().optional(),
    items: z.array(inventoryEntryProductSchema).min(1),
}).refine(
    (data) => Boolean(data.invoiceId) !== Boolean(data.supplierId),
    { message: 'Cada entrada debe incluir invoiceId o supplierId, no ambos' },
);

export const bulkCreateEntriesSchema = z.object({
    entries: z.array(bulkEntryGroupSchema).min(1).max(100),
});

export const inventoryEntrySchema = z.object({
    invoiceId: z.string().min(1),
    products: z.array(inventoryEntryProductSchema).min(1).optional(),
    items: z.array(inventoryEntryProductSchema).min(1).optional(),
}).refine(
    (data) => Boolean(data.products?.length || data.items?.length),
    { message: 'Debe incluir al menos un producto' },
).transform((data) => ({
    invoiceId: data.invoiceId,
    products: data.products ?? data.items ?? [],
}));

const createProductFieldsSchema = z
    .object({
        name: z.string().min(1),
        sku: z.string().min(1),
        barcode: z.string().optional(),
        activeIngredient: z.string().optional(),
        categoryId: z.string().min(1),
        unit: z.string().min(1),
        salePrice: z.number().nonnegative(),
        minStock: z.number().int().nonnegative(),
        hasIva: z.boolean(),
        hasIvaZero: z.boolean(),
        hasIeps: z.boolean(),
        concentration: z.string().optional(),
    })
    .refine((data) => !(data.hasIva && data.hasIvaZero), {
        message: 'Un producto no puede tener IVA e IVA cero al mismo tiempo',
        path: ['hasIvaZero'],
    });

export const directInventoryEntryItemSchema = z
    .object({
        productId: z.string().min(1).optional(),
        product: createProductFieldsSchema.optional(),
        expiryDate: z.string().min(1),
        quantity: z.number().positive(),
        lotNumber: z.string().min(1).optional(),
        costPrice: z.number().nonnegative().optional(),
    })
    .refine(
        (data) => Boolean(data.productId) !== Boolean(data.product),
        { message: 'Cada ítem debe incluir productId o product, no ambos' },
    );

export const directInventoryEntrySchema = z.object({
    supplierId: z.string().min(1),
    notes: z.string().optional(),
    items: z.array(directInventoryEntryItemSchema).min(1),
});

export const createSupplierSchema = z.object({
    name: z.string().min(1),
    contactName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
});

export const updateSupplierSchema = z.object({
    name: z.string().min(1).optional(),
    contactName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
    isActive: z.boolean().optional(),
});

export const listSuppliersQuerySchema = z.object({
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const inventoryExitSchema = z.object({
    productId: z.string().min(1),
    batchId: z.string().min(1),
    quantity: z.number().positive(),
    reason: z.enum(['waste', 'expiry']),
    notes: z.string().optional(),
});

export const createSaleSchema = z.object({
    items: z.array(z.object({
        productId: z.string().min(1),
        quantity: z.number().positive(),
    })).min(1),
    paymentMethod: z.enum(['cash', 'card', 'transfer']),
});

export const idParamSchema = z.object({
    id: z.string().min(1),
});

export const listProductsQuerySchema = z.object({
    categoryId: z.string().optional(),
    activeOnly: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const listProductHistoryQuerySchema = z.object({
    ...paginationFields,
});

export const listBatchesQuerySchema = z.object({
    productId: z.string().min(1),
    ...paginationFields,
});

export const listMovementsQuerySchema = z.object({
    productId: z.string().optional(),
    type: z.enum(['entry', 'exit_waste', 'exit_expiry', 'sale_adjustment']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    ...paginationFields,
});

export const listEntriesQuerySchema = z.object({
    supplierId: z.string().optional(),
    invoiceId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    ...paginationFields,
});

export const createInvoiceSchema = z.object({
    supplierId: z.string().min(1),
    invoiceNumber: z.string().min(1),
    invoiceDate: z.string().min(1),
    totalAmount: z.number().positive(),
    hasInvoice: z.boolean(),
    fileUrl: z.string().min(1).startsWith('uploads/'),
});

export const listInvoicesQuerySchema = z.object({
    supplierId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    hasInvoice: z.enum(['true', 'false']).optional(),
    ...paginationFields,
});

export const listSalesQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    ...paginationFields,
});
