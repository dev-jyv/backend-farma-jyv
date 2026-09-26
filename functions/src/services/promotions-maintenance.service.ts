import { Promotion, PromotionPerformance } from '../types';
import * as promotionsRepo from '../repositories/promotions.repository';
import { recordAudit } from './audit.service';
import { computePromotionPerformance } from './promotion-performance.service';

/**
 * Mantenimiento diario de promociones (lo corre `dailyPromotionsMaintenance`).
 *
 * Una promo con `endsAt` vencido ya no se aplica —la vigencia la decide la
 * fecha, no `isActive`—, pero seguía listándose como activa en el admin y
 * contando para `hasActivePromotion`. Darla de baja aquí sella `deactivatedAt`
 * (después de `endsAt`, así que el fin efectivo sigue siendo `endsAt`) y deja el
 * cierre en la bitácora con su desempeño final.
 *
 * Sin correo: eso lo hace `promotion-alerts-sender.service`, para poder probar
 * esto sin Resend ni React.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SYSTEM_ACTOR = 'system';

export interface ClosedPromotion {
    promotion: Promotion;
    /** `null` si falló el cálculo: la baja ya ocurrió y el aviso sale igual. */
    performance: PromotionPerformance | null;
}

export interface PromotionsMaintenanceResult {
    closed: ClosedPromotion[];
    /** Activas que terminan en las próximas 24 h, de la más próxima a la más lejana. */
    endingSoon: Promotion[];
}

export const runPromotionsMaintenance = async (
    options: { nowMs?: number } = {},
): Promise<PromotionsMaintenanceResult> => {
    const nowMs = options.nowMs ?? Date.now();
    const active = await promotionsRepo.listPromotions({ activeOnly: true });

    const expired = active.filter((promotion) =>
        promotion.endsAt !== null && promotion.endsAt.toMillis() < nowMs);
    const endingSoon = active
        .filter((promotion) => promotion.endsAt !== null &&
            promotion.endsAt.toMillis() >= nowMs &&
            promotion.endsAt.toMillis() <= nowMs + MS_PER_DAY)
        .sort((a, b) => a.endsAt!.toMillis() - b.endsAt!.toMillis());

    const closed: ClosedPromotion[] = [];
    // En serie: son pocas por día y cada una es su propia transacción; en
    // paralelo no se gana nada y un error se vuelve difícil de atribuir.
    for (const promotion of expired) {
        const { before, after } = await promotionsRepo.updatePromotion(promotion.id, {
            isActive: false,
            updatedBy: SYSTEM_ACTOR,
        });
        // Otra baja pudo ganar entre la lectura y la transacción: no se audita
        // dos veces ni se reporta como cierre de hoy.
        if (!before.isActive) {
            continue;
        }
        await recordAudit({
            action: 'promotion.deactivated',
            entity: 'promotion',
            entityId: promotion.id,
            summary: `Promoción "${promotion.name}" dada de baja al terminar su vigencia`,
            userId: SYSTEM_ACTOR,
            roleSlug: null,
            changes: { isActive: { before: true, after: false } },
            metadata: {
                reason: 'expired',
                endsAt: promotion.endsAt!.toDate().toISOString(),
            },
        });

        let performance: PromotionPerformance | null = null;
        try {
            performance = await computePromotionPerformance(after, nowMs);
        } catch (error) {
            console.error('No se pudo calcular el desempeño de la promoción cerrada', {
                promotionId: promotion.id,
                error,
            });
        }
        closed.push({ promotion: after, performance });
    }

    return { closed, endingSoon };
};

/** ¿Hay algo que avisar? Un correo diario vacío enseña a ignorarlo. */
export const hasMaintenanceNews = (result: PromotionsMaintenanceResult): boolean =>
    result.closed.length > 0 || result.endingSoon.length > 0;
