import { Product, Promotion } from '../types';
import { PromotionsMaintenanceEmail } from '../emails/promotions-maintenance.email';
import { PromotionsRetiredEmail } from '../emails/promotions-retired.email';
import { describePromotionRule } from '../emails/components/promotion-text';
import { sendReportEmail } from './email.service';
import {
    PromotionsMaintenanceResult,
    hasMaintenanceNews,
    runPromotionsMaintenance,
} from './promotions-maintenance.service';

/**
 * Correos de promociones, a los mismos destinatarios que los reportes de
 * ventas (`REPORTS_EMAIL_TO`). Separado de la lógica, igual que
 * `inventory-alerts-sender`: este módulo arrastra Resend y React Email, y solo
 * lo cargan la función programada y, por import dinámico, la baja por precio.
 */

/**
 * Corre el mantenimiento y avisa si hubo algo. Las bajas ocurren aunque el
 * correo falle: si Resend está caído, mañana la promo ya no está activa y no
 * se vuelve a reportar como cerrada —se pierde el aviso, no la baja—.
 */
export const sendPromotionsMaintenanceReport = async (
    options: { nowMs?: number } = {},
): Promise<{ sent: boolean; result: PromotionsMaintenanceResult }> => {
    const result = await runPromotionsMaintenance(options);
    if (!hasMaintenanceNews(result)) {
        return { sent: false, result };
    }
    await sendReportEmail({
        subject: `Promociones — ${result.closed.length} cerradas, ` +
            `${result.endingSoon.length} terminan en 24 h`,
        react: PromotionsMaintenanceEmail({
            closed: result.closed,
            endingSoon: result.endingSoon,
        }),
    });
    return { sent: true, result };
};

/** Aviso de bajas por cambio de precio. Lanza si falla: quien llama lo absorbe. */
export const sendPromotionsRetiredByPriceEmail = async (
    product: Pick<Product, 'name' | 'salePrice'>,
    retired: Array<{ promotion: Promotion; problem: string }>,
): Promise<void> => {
    if (!retired.length) {
        return;
    }
    await sendReportEmail({
        subject: retired.length === 1
            ? `Promoción "${retired[0].promotion.name}" dada de baja por cambio de precio`
            : `${retired.length} promociones dadas de baja por cambio de precio`,
        react: PromotionsRetiredEmail({
            product: { name: product.name, salePrice: product.salePrice },
            retired: retired.map(({ promotion, problem }) => ({
                id: promotion.id,
                name: promotion.name,
                ruleText: describePromotionRule(promotion.rule),
                problem,
            })),
        }),
    });
};
