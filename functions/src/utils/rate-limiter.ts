/**
 * Límite por llave con ventana deslizante, en memoria de la instancia. Igual que
 * `MemoryCache`, no es distribuido: acota el gasto por usuario en una instancia
 * caliente, no es una cuota global.
 */
export class RateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly maxKeys = 1000,
    ) {}

    tryConsume(key: string, now = Date.now()): boolean {
        const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
        if (recent.length >= this.limit) {
            this.hits.set(key, recent);
            return false;
        }
        if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
            const oldest = this.hits.keys().next();
            if (!oldest.done) {
                this.hits.delete(oldest.value);
            }
        }
        this.hits.set(key, [...recent, now]);
        return true;
    }
}
