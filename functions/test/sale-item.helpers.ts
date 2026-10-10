import {
    Sale,
    SaleProductItem,
    SaleServiceItem,
    isSaleProductItem,
    isSaleServiceItem,
} from '../src/types';

/**
 * Ayudas para leer partidas de venta en las pruebas.
 *
 * Desde que la venta cobra servicios, `sale.items` es una unión discriminada: una
 * prueba que quiere el lote o el costo de un renglón tiene que estrecharlo
 * primero. Estas funciones lo hacen y fallan ruidosamente si el renglón no es de
 * la naturaleza esperada, en vez de dejar pasar un `undefined`.
 */

export const productItems = (sale: Sale): SaleProductItem[] =>
    sale.items.filter(isSaleProductItem);

export const serviceItems = (sale: Sale): SaleServiceItem[] =>
    sale.items.filter(isSaleServiceItem);

export const productItem = (sale: Sale, index = 0): SaleProductItem => {
    const item = productItems(sale)[index];
    if (!item) {
        throw new Error(`La venta no tiene partida de mercancía en la posición ${index}`);
    }
    return item;
};

export const serviceItem = (sale: Sale, index = 0): SaleServiceItem => {
    const item = serviceItems(sale)[index];
    if (!item) {
        throw new Error(`La venta no tiene partida de servicio en la posición ${index}`);
    }
    return item;
};
