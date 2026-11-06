import { Sale, isSaleProductItem, isSaleServiceItem } from '../types';
import { fromCents, toCents } from './taxes';

/**
 * Partidas cobradas a un precio distinto del catálogo (SPEC 64).
 *
 * `createSale` guarda `catalogUnitPrice` **solo cuando** el precio cobrado
 * difiere del catálogo; aquí se lee esa señal. Se compara el precio unitario
 * cobrado contra el de catálogo, nunca el neto: una promoción o un cupón bajan
 * el neto, no el `unitPrice`, así que no cuentan como precio distinto.
 *
 * En una partida por caja (SPEC 46) `catalogUnitPrice` es el `boxPrice` del
 * catálogo y `unitPrice` el precio efectivo por pieza, así que se compara contra
 * `saleUnit.boxPrice` (lo cobrado por caja) y la cantidad va en cajas.
 */
export interface PriceDeviationLine {
    /** Producto o servicio; en una partida por caja lleva "(caja de N)". */
    name: string;
    /** Precio de catálogo por unidad cobrada (pieza, caja o servicio). */
    catalogUnitPrice: number;
    /** Precio cobrado por esa misma unidad. */
    unitPrice: number;
    /** Unidades cobradas: piezas, cajas o servicios. */
    quantity: number;
    /** `(cobrado − catálogo) × cantidad`; negativa cuando se cobró menos. */
    difference: number;
}

export const priceDeviationLines = (sale: Pick<Sale, 'items'>): PriceDeviationLine[] => {
    const lines: PriceDeviationLine[] = [];
    for (const item of sale.items) {
        if (isSaleProductItem(item)) {
            const box = item.saleUnit?.type === 'box' ? item.saleUnit : null;
            const charged = box ? box.boxPrice : item.unitPrice;
            const quantity = box ? box.boxes : item.quantity;
            const line = buildLine(
                box ? `${item.productName} (caja de ${box.piecesPerBox})` : item.productName,
                item.catalogUnitPrice,
                charged,
                quantity,
            );
            if (line) {
                lines.push(line);
            }
        } else if (isSaleServiceItem(item)) {
            const line = buildLine(
                item.serviceName,
                item.catalogUnitPrice,
                item.unitPrice,
                item.quantity,
            );
            if (line) {
                lines.push(line);
            }
        }
    }
    return lines;
};

const buildLine = (
    name: string,
    catalogUnitPrice: number | null | undefined,
    unitPrice: number,
    quantity: number,
): PriceDeviationLine | null => {
    // Las ventas anteriores a la señal no la traen: no aparecen.
    if (catalogUnitPrice === undefined || catalogUnitPrice === null) {
        return null;
    }
    const deltaCents = toCents(unitPrice) - toCents(catalogUnitPrice);
    if (deltaCents === 0) {
        return null;
    }
    return {
        name,
        catalogUnitPrice,
        unitPrice,
        quantity,
        difference: fromCents(deltaCents * quantity),
    };
};
