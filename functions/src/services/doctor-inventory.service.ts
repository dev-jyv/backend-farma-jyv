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
 * (que no pasa por caché) lo corrige en la siguiente sincronización. Guarda la
 * hora de lectura: es el cursor que se entrega con la carga completa.
 */
const fullCache = new MemoryCache<{ items: DoctorInventoryItem[]; readAt: string }>(60_000, 1);

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

    let cached = fullCache.get(FULL_CACHE_KEY);
    if (!cached) {
        const products = await productsRepo.listProducts({ activeOnly: true });
        cached = { items: products.map(toItem), readAt: serverTime };
        fullCache.set(FULL_CACHE_KEY, cached);
    }
    // El cursor es la hora en que se leyó el catálogo, no la del request: con una
    // copia de hasta 60 s, un cambio posterior a la lectura quedaría por debajo
    // del cursor y ningún delta lo volvería a enviar.
    return {
        items: cached.items,
        meta: { serverTime: cached.readAt, full: true, total: cached.items.length },
    };
};
