import { Batch, Product } from '../types';
import { MemoryCache } from '../utils/memory-cache';
import * as batchesRepo from '../repositories/batches.repository';
import * as productsRepo from '../repositories/products.repository';

/**
 * Lectura compartida del catálogo (productos + lotes con existencia) para
 * reportes, alertas y el asistente.
 *
 * Todos ellos releían el catálogo completo en cada request: con 3k productos y
 * 5k lotes, ~8k lecturas por llamada, varias veces al día. Aquí una sola
 * lectura por instancia sirve a todos durante el TTL, y las peticiones
 * concurrentes en frío comparten la misma promesa.
 *
 * Solo para consultas de lectura donde unos segundos de desfase son tolerables.
 * Nada que valide o descuente existencias (ventas, salidas, conteos) debe pasar
 * por aquí: esas rutas leen dentro de su transacción.
 */
const DEFAULT_TTL_MS = 60_000;

const ttlMs = (): number => {
    const configured = Number(process.env.CATALOG_SNAPSHOT_TTL_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_TTL_MS;
};

const PRODUCTS_KEY = 'products';
const BATCHES_KEY = 'batches';

let products = new MemoryCache<Promise<Product[]>>(DEFAULT_TTL_MS, 1);
let batches = new MemoryCache<Promise<Batch[]>>(DEFAULT_TTL_MS, 1);
let configuredTtl = DEFAULT_TTL_MS;

const ensureTtl = (): void => {
    const next = ttlMs();
    if (next !== configuredTtl) {
        configuredTtl = next;
        products = new MemoryCache(next, 1);
        batches = new MemoryCache(next, 1);
    }
};

const load = <T>(
    cache: MemoryCache<Promise<T[]>>,
    key: string,
    read: () => Promise<T[]>,
): Promise<T[]> => {
    let pending = cache.get(key);
    if (!pending) {
        pending = read();
        cache.set(key, pending);
        // Un fallo no se cachea: el siguiente request reintenta.
        pending.catch(() => cache.invalidate(key));
    }
    // Copia del arreglo: los consumidores ordenan y filtran en sitio.
    return pending.then((items) => [...items]);
};

/**
 * Misma firma que `productsRepo.listProducts({ activeOnly })`. Se lee el
 * catálogo completo una vez y el filtro por activos se hace en memoria, así que
 * activos e inactivos comparten una sola lectura.
 */
export const listProducts = async (
    filters: { activeOnly?: boolean } = {},
): Promise<Product[]> => {
    ensureTtl();
    const all = await load(products, PRODUCTS_KEY, () =>
        productsRepo.listProducts({ activeOnly: false }),
    );
    return filters.activeOnly === false ? all : all.filter((product) => product.isActive);
};

export const listBatchesWithStock = async (): Promise<Batch[]> => {
    ensureTtl();
    return load(batches, BATCHES_KEY, () => batchesRepo.listBatchesWithStock());
};

export const clearCatalogSnapshot = (): void => {
    products.clear();
    batches.clear();
};
