import { Sale } from '../types';

/** Venta tal como sale por HTTP: fechas de negocio en ISO (SPEC 51). */
export type SaleResponse = Omit<Sale, 'businessAt' | 'soldAt'> & {
    businessAt?: string;
    soldAt?: string | null;
};

/**
 * Venta para la respuesta HTTP: `businessAt` (y `soldAt`) viajan en ISO
 * (SPEC 51); el resto de la venta sale igual que siempre. Toda venta leída o
 * recién escrita trae `createdAt`, así que `businessAt` siempre sale. Vive fuera
 * de `sales.service` para que las pruebas que simulan ese servicio no la pierdan.
 */
export const toSaleResponse = (sale: Sale): SaleResponse => {
    const { businessAt, soldAt, ...rest } = sale;
    const at = businessAt ?? sale.createdAt;
    return {
        ...rest,
        ...(at ? { businessAt: at.toDate().toISOString() } : {}),
        ...(soldAt !== undefined
            ? { soldAt: soldAt ? soldAt.toDate().toISOString() : null }
            : {}),
    };
};
