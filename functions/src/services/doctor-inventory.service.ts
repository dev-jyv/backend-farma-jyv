import * as productsRepo from '../repositories/products.repository';
import { ControlledGroup, Product } from '../types';
import { MemoryCache } from '../utils/memory-cache';

/**
 * Vista del inventario para el médico: sin precios, costos, proveedores ni lotes.
 * `totalStock` ya viene denormalizado en el producto, así que no se leen lotes.
 */
export interface DoctorInventoryItem {
    id: string;
    name: string;
    activeIngredient: string | null;
    concentration: string | null;
    unit: string;
    categoryId: string;
    totalStock: number;
    minStock: number;
    controlledGroup: ControlledGroup | null;
    isActive: boolean;
    updatedAt: string;
}

export interface DoctorInventoryResult {
    items: DoctorInventoryItem[];
    meta: { serverTime: string; full: boolean; total: number };
}

const FULL_CACHE_KEY = 'full';
/**
 * La carga completa lee todo el catálogo activo: se comparte entre requests de la
 * instancia. 60 s de desfase es tolerable para consultar existencias; el delta
 * (que no pasa por caché) lo corrige en la siguiente sincronización.
 */
const fullCache = new MemoryCache<DoctorInventoryItem[]>(60_000, 1);

export const clearDoctorInventoryCache = (): void => fullCache.clear();

const toItem = (product: Product): DoctorInventoryItem => ({
    id: product.id,
    name: product.name,
    activeIngredient: product.activeIngredient ?? null,
    concentration: product.concentration ?? null,
    unit: product.unit,
    categoryId: product.categoryId,
    totalStock: product.totalStock ?? 0,
    minStock: product.minStock,
    controlledGroup: product.controlledGroup ?? null,
    isActive: product.isActive,
    updatedAt: product.updatedAt.toDate().toISOString(),
});

export const getDoctorInventory = async (
    updatedSince?: string,
): Promise<DoctorInventoryResult> => {
    // El cursor se toma ANTES de leer: un cambio durante la lectura se vuelve a
    // enviar en el siguiente delta en lugar de perderse.
    const serverTime = new Date().toISOString();

    if (updatedSince) {
        // activeOnly:false para que el cliente pueda retirar productos desactivados.
        const changed = await productsRepo.listProducts({ activeOnly: false, updatedSince });
        const items = changed.map(toItem);
        return { items, meta: { serverTime, full: false, total: items.length } };
    }

    let items = fullCache.get(FULL_CACHE_KEY);
    if (!items) {
        const products = await productsRepo.listProducts({ activeOnly: true });
        items = products.map(toItem);
        fullCache.set(FULL_CACHE_KEY, items);
    }
    return { items, meta: { serverTime, full: true, total: items.length } };
};
