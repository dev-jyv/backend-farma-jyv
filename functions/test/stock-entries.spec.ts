import { createStockEntrySchema } from '../src/schemas/stock-entries';

/**
 * Reglas de la entrada de stock desde la caja. Todo es validación pura del
 * schema: no toca Firestore ni el emulador.
 */

const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const yesterday = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const nuevoProducto = {
    name: 'Paracetamol 500mg',
    sku: 'PARA-500',
    categoryId: 'cat-1',
    unit: 'caja',
    salePrice: 45.5,
    minStock: 5,
    hasIva: true,
    hasIvaZero: false,
    hasIeps: false,
};

const base = {
    invoiceId: 'inv-1',
    lotNumber: 'L-2026-08',
    expiryDate: tomorrow(),
    quantity: 24,
};

const parseQuantity = (quantity: number): boolean =>
    createStockEntrySchema.safeParse({ ...base, quantity, productId: 'p1' }).success;

const parseCostPrice = (costPrice: number): boolean =>
    createStockEntrySchema.safeParse({ ...base, productId: 'p1', costPrice }).success;

describe('createStockEntrySchema', () => {
    it('acepta una partida sobre un producto existente', () => {
        const result = createStockEntrySchema.safeParse({ ...base, productId: 'p1' });
        expect(result.success).toBe(true);
    });

    it('acepta el alta de un producto junto con su entrada', () => {
        const result = createStockEntrySchema.safeParse({ ...base, product: nuevoProducto });
        expect(result.success).toBe(true);
    });

    it('exige productId o product, nunca ambos', () => {
        expect(createStockEntrySchema.safeParse(base).success).toBe(false);
        expect(
            createStockEntrySchema.safeParse({ ...base, productId: 'p1', product: nuevoProducto })
                .success,
        ).toBe(false);
    });

    it('rechaza correcciones de producto sin producto existente', () => {
        const result = createStockEntrySchema.safeParse({
            ...base,
            product: nuevoProducto,
            productUpdate: { salePrice: 60 },
        });
        expect(result.success).toBe(false);
    });

    it('acepta correcciones sobre el producto existente', () => {
        const result = createStockEntrySchema.safeParse({
            ...base,
            productId: 'p1',
            productUpdate: { salePrice: 60, minStock: 10 },
        });
        expect(result.success).toBe(true);
    });

    it('no recibe mercancía vencida', () => {
        const result = createStockEntrySchema.safeParse({
            ...base,
            expiryDate: yesterday(),
            productId: 'p1',
        });
        expect(result.success).toBe(false);
    });

    it('exige lote: sin él, el stock nuevo no se puede vender con FEFO', () => {
        const result = createStockEntrySchema.safeParse({
            ...base,
            lotNumber: '  ',
            productId: 'p1',
        });
        expect(result.success).toBe(false);
    });

    it('la cantidad es un entero positivo', () => {
        expect(parseQuantity(0)).toBe(false);
        expect(parseQuantity(-3)).toBe(false);
        expect(parseQuantity(1.5)).toBe(false);
    });

    it('el costo es opcional, con dos decimales como máximo', () => {
        expect(parseCostPrice(12.34)).toBe(true);
        expect(parseCostPrice(12.345)).toBe(false);
    });

    it('hereda las reglas fiscales del alta de producto', () => {
        const ivaDoble = createStockEntrySchema.safeParse({
            ...base,
            product: { ...nuevoProducto, hasIva: true, hasIvaZero: true },
        });
        expect(ivaDoble.success).toBe(false);

        const iepsSinTasa = createStockEntrySchema.safeParse({
            ...base,
            product: { ...nuevoProducto, hasIeps: true },
        });
        expect(iepsSinTasa.success).toBe(false);

        const iepsConTasa = createStockEntrySchema.safeParse({
            ...base,
            product: { ...nuevoProducto, hasIeps: true, iepsRate: 0.08 },
        });
        expect(iepsConTasa.success).toBe(true);
    });
});
