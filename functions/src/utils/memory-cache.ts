/**
 * Caché en memoria del proceso, con expiración por entrada.
 *
 * Vive lo que viva la instancia de la Cloud Function: en instancias calientes
 * ahorra lecturas repetidas de Firestore entre requests, y en un arranque en
 * frío simplemente empieza vacía. No es una caché distribuida: dos instancias
 * pueden tener valores distintos hasta que expira el TTL, así que solo debe
 * usarse para datos donde esa ventana de desfase es tolerable.
 */
export class MemoryCache<T> {
    private readonly entries = new Map<string, { value: T; expiresAt: number }>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries = 500,
    ) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: T): void {
        // Cota simple para que una instancia de larga vida no crezca sin límite:
        // al llenarse se descarta la entrada más antigua insertada.
        if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
            const oldest = this.entries.keys().next();
            if (!oldest.done) {
                this.entries.delete(oldest.value);
            }
        }
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }

    invalidate(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}
