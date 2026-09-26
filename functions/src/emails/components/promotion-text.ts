import { PromotionRule } from '../../types';
import { formatCurrency } from '../../utils/currency';
import { REPORTS_TIME_ZONE } from '../../services/sales-reports.service';

/**
 * Textos compartidos por los correos de promociones. La regla se describe como
 * la leería el mostrador ("2 por $60", "2x1"), no con el nombre técnico del
 * tipo: el correo lo abre el dueño en el teléfono, no quien la capturó.
 */

export const describePromotionRule = (rule: PromotionRule): string => {
    if (rule.type === 'tiered') {
        return rule.tiers
            .map((tier) => `${tier.quantity} por ${formatCurrency(tier.price)}`)
            .join(' · ');
    }
    if (rule.type === 'nxm') {
        return `${rule.buy}x${rule.pay}`;
    }
    return rule.minQty > 1
        ? `${rule.percent} % desde ${rule.minQty} piezas`
        : `${rule.percent} % de descuento`;
};

const dateTimeFormatter = new Intl.DateTimeFormat('es-MX', {
    timeZone: REPORTS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

/** Fecha y hora en la zona de la farmacia (la function corre en UTC). */
export const formatPromotionDate = (value: Date | string): string =>
    dateTimeFormatter.format(typeof value === 'string' ? new Date(value) : value);
