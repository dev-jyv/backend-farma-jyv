import { MemoryCache } from '../src/utils/memory-cache';

/**
 * La caché del guard vive en la instancia de la Cloud Function y decide si una
 * request paga o no una lectura de Firestore. Los dos riesgos son opuestos:
 * servir un valor caducado (un usuario desactivado que sigue entrando) o crecer
 * sin tope en una instancia de larga vida.
 */

describe('MemoryCache', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('devuelve undefined para una clave que nunca se escribió', () => {
        expect(new MemoryCache<string>(1000).get('sin-escribir')).toBeUndefined();
    });

    it('distingue un valor nulo cacheado de una ausencia de caché', () => {
        // El guard cachea `null` para los uid sin perfil: si `get` no supiera
        // distinguirlo de "no hay entrada", cada request de un uid inexistente
        // volvería a leer Firestore.
        const cache = new MemoryCache<string | null>(1000);
        cache.set('fantasma', null);
        expect(cache.get('fantasma')).toBeNull();
    });

    it('deja de servir el valor al cumplirse el TTL', () => {
        jest.useFakeTimers();
        const cache = new MemoryCache<string>(60_000);
        cache.set('k', 'v');

        jest.advanceTimersByTime(59_999);
        expect(cache.get('k')).toBe('v');

        jest.advanceTimersByTime(1);
        expect(cache.get('k')).toBeUndefined();
    });

    it('renueva el TTL al reescribir la clave', () => {
        jest.useFakeTimers();
        const cache = new MemoryCache<string>(60_000);
        cache.set('k', 'v1');

        jest.advanceTimersByTime(50_000);
        cache.set('k', 'v2');
        jest.advanceTimersByTime(50_000);

        expect(cache.get('k')).toBe('v2');
    });

    it('invalida una sola clave sin tocar las demás', () => {
        const cache = new MemoryCache<string>(60_000);
        cache.set('a', '1');
        cache.set('b', '2');

        cache.invalidate('a');

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe('2');
    });

    it('vacía todo con clear', () => {
        const cache = new MemoryCache<string>(60_000);
        cache.set('a', '1');
        cache.set('b', '2');

        cache.clear();

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBeUndefined();
    });

    it('respeta el tope de entradas descartando la más antigua', () => {
        const cache = new MemoryCache<string>(60_000, 2);
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('c', '3');

        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe('2');
        expect(cache.get('c')).toBe('3');
    });

    it('reescribir una clave existente no cuenta contra el tope', () => {
        const cache = new MemoryCache<string>(60_000, 2);
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('a', '1-bis');

        // Si reescribir desalojara, un uid que se refresca seguido echaría a los
        // demás del cache sin necesidad.
        expect(cache.get('a')).toBe('1-bis');
        expect(cache.get('b')).toBe('2');
    });
});
