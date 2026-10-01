/**
 * Foto del inventario con un caso cerrado: valuación a costo y a venta,
 * rotación, caducidad, mercancía sin venta y concentración por categoría.
 */

import { Product, Sale } from '../src/types';
import { summarizeInventory } from '../src/services/inventory-summary.service';

const DAY = 24 * 60 * 60 * 1000;
const asOf = new Date('2026-09-29T12:00:00.000Z');
const inDays = (days: number) => new Date(asOf.getTime() + days * DAY);

const product = (overrides: Partial<Product>): Product => ({
    id: 'p',
    name: 'Producto',
    sku: 'SKU',
    categoryId: 'c1',
    unit: 'pieza',
    salePrice: 0,
    minStock: 0,
    hasIva: false,
    hasIvaZero: false,
    hasIeps: false,
    isActive: true,
    ...overrides,
}) as Product;

const summary = () => summarizeInventory({
    products: [
        product({ id: 'p1', name: 'Paracetamol', salePrice: 116, hasIva: true, minStock: 5 }),
        product({ id: 'p2', name: 'Gasas', categoryId: 'c2', salePrice: 50, minStock: 5 }),
        product({ id: 'p3', name: 'Agotado' }),
    ],
    batches: [
        { productId: 'p1', quantity: 10, costPrice: 50, expiryDate: inDays(20) },
        { productId: 'p1', quantity: 2, expiryDate: inDays(200) },
        { productId: 'p2', quantity: 4, costPrice: 20, expiryDate: inDays(-5) },
    ],
    categoryNames: new Map([['c1', 'Analgésicos'], ['c2', 'Curación']]),
    sales: [
        { items: [{ productId: 'p1', quantity: 9, costAmount: 450 }] } as unknown as Sale,
    ],
    windowDays: 90,
    asOf,
});

describe('resumen de inventario', () => {
    it('valúa a costo, a venta con impuestos y compara el costo contra la base sin IVA', () => {
        expect(summary().valuation).toEqual({
            cost: 580,
            retail: 1592,
            retailBase: 1400,
            // Solo lotes con costo: 1000 + 200 de base contra 580 de costo.
            potentialProfit: 620,
            potentialMarginRate: 51.67,
            batchesWithoutCost: 1,
            unitsWithoutCost: 2,
        });
    });

    it('cuenta existencia, agotados y stock bajo sobre el catálogo activo', () => {
        expect(summary().stock).toEqual({
            units: 16,
            batches: 3,
            activeProducts: 3,
            productsWithStock: 2,
            outOfStock: 1,
            lowStock: 1,
        });
    });

    it('mide la rotación con el costo de lo vendido en la ventana', () => {
        expect(summary().turnover).toEqual({
            soldCost: 450,
            daysOfInventory: 116,
            annualTurnover: 3.15,
        });
    });

    it('separa el dinero en riesgo por caducidad y por falta de venta', () => {
        const result = summary();

        expect(result.expiry).toEqual([
            { bucket: 'expired', batches: 1, units: 4, cost: 80 },
            { bucket: 'days30', batches: 1, units: 10, cost: 500 },
            { bucket: 'days60', batches: 0, units: 0, cost: 0 },
            { bucket: 'days90', batches: 0, units: 0, cost: 0 },
        ]);
        expect(result.deadStock).toEqual({ products: 1, units: 4, cost: 80 });
    });

    it('ordena categorías y productos por dinero inmovilizado', () => {
        const result = summary();

        expect(result.byCategory).toEqual([
            {
                categoryId: 'c1',
                categoryName: 'Analgésicos',
                units: 12,
                cost: 500,
                retail: 1392,
                share: 86.21,
            },
            {
                categoryId: 'c2',
                categoryName: 'Curación',
                units: 4,
                cost: 80,
                retail: 200,
                share: 13.79,
            },
        ]);
        expect(result.topProducts.map((item) => [item.productId, item.daysOfCover])).toEqual([
            ['p1', 120],
            ['p2', null],
        ]);
    });

    it('sin ventas no inventa rotación', () => {
        const result = summarizeInventory({
            products: [product({ id: 'p1', salePrice: 10 })],
            batches: [{ productId: 'p1', quantity: 3, costPrice: 5, expiryDate: inDays(400) }],
            categoryNames: new Map(),
            sales: [],
            windowDays: 90,
            asOf,
        });

        expect(result.turnover).toEqual({
            soldCost: 0,
            daysOfInventory: null,
            annualTurnover: null,
        });
        expect(result.byCategory[0].categoryName).toBe('Sin categoría');
    });
});
