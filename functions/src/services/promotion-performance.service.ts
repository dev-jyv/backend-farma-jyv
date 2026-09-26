import { Timestamp } from 'firebase-admin/firestore';
import { Promotion, PromotionPerformance } from '../types';
import { buildPromotionPerformance, performanceWindows } from '../utils/promotion-performance';
import * as salesRepo from '../repositories/sales.repository';

/**
 * Lee lo que necesita el desempeño de una promoción y delega el cálculo en
 * `utils/promotion-performance.ts`. Separado de `promotions.service` para que
 * el mantenimiento programado lo use sin cargar el resto del CRUD (y sin ciclo
 * de imports: `promotions.service` sí depende de este).
 *
 * Son dos consultas: las ventas de la promo (`promotionIds array-contains`) y
 * las de sus productos en la ventana previa (`productIds array-contains-any`
 * por bloques de 30 + rango de `createdAt`).
 */
export const computePromotionPerformance = async (
    promotion: Promotion,
    nowMs = Date.now(),
): Promise<PromotionPerformance> => {
    const windows = performanceWindows(promotion, nowMs);
    const [promotionSales, baselineSales] = await Promise.all([
        salesRepo.listSalesByPromotion(promotion.id),
        salesRepo.listSalesByProductsBetween(
            promotion.productIds,
            Timestamp.fromMillis(windows.baselineFromMs),
            Timestamp.fromMillis(windows.startMs),
        ),
    ]);
    return buildPromotionPerformance({ promotion, nowMs, promotionSales, baselineSales });
};
