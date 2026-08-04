import { InventoryAlertsEmail } from '../emails/inventory-alerts.email';
import { sendReportEmail } from './email.service';
import { getInventoryAlerts, hasActionableAlerts } from './inventory-alerts.service';

/**
 * Manda el resumen de caducidades y stock bajo. Si no hay nada que reportar no se
 * manda correo: un aviso diario vacío enseña al equipo a ignorar el aviso.
 */
type AlertTotals = Awaited<ReturnType<typeof getInventoryAlerts>>['totals'];

export const sendInventoryAlertsReport = async (options: {
    expiryWindows?: number[];
    force?: boolean;
} = {}): Promise<{ sent: boolean; totals: AlertTotals }> => {
    const alerts = await getInventoryAlerts({ expiryWindows: options.expiryWindows });

    if (!options.force && !hasActionableAlerts(alerts)) {
        return { sent: false, totals: alerts.totals };
    }

    const { totals } = alerts;
    await sendReportEmail({
        subject: `Alertas de inventario — ${totals.expiredBatches} vencidos, ` +
            `${totals.expiringBatches} por vencer, ${totals.lowStockProducts} con stock bajo`,
        react: InventoryAlertsEmail({ alerts }),
    });

    return { sent: true, totals };
};
