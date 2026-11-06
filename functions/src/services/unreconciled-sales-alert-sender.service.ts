import {
    UnreconciledSaleAlertEmail,
    unreconciledSaleSubject,
} from '../emails/unreconciled-sale-alert.email';
import * as diagnosticsRepo from '../repositories/pos-diagnostics.repository';
import * as usersRepo from '../repositories/users.repository';
import { UnreconciledSale } from '../types';
import { formatLocalDateTime } from '../utils/timezone';
import { sendReportEmail } from './email.service';

/**
 * Envío del aviso de venta no conciliada (SPEC 53).
 *
 * Arrastra Resend y React Email: **solo se importa con `await import()`** desde
 * `recordUnreconciledSale`. Un import estático lo metería en el arranque en frío
 * de `api`. Va a `REPORTS_EMAIL_TO`, como el resto de los avisos.
 *
 * Lanza si algo falla; quien lo llama traga el error.
 */

/** Nombre de la caja: el de su diagnóstico, su id, o la del cajero si no se mandó. */
export const describeDevice = (
    sale: Pick<UnreconciledSale, 'deviceId'>,
    deviceName: string | null,
    cashierLabel: string,
): string => {
    if (deviceName) {
        return deviceName;
    }
    if (sale.deviceId) {
        return sale.deviceId;
    }
    return `la caja de ${cashierLabel}`;
};

export const sendUnreconciledSaleAlert = async (sale: UnreconciledSale): Promise<void> => {
    const [profile, deviceNames] = await Promise.all([
        usersRepo.getUserProfile(sale.cashierId).catch(() => null),
        sale.deviceId
            ? diagnosticsRepo.getDeviceNames([sale.deviceId]).catch(() => new Map<string, string>())
            : Promise.resolve(new Map<string, string>()),
    ]);
    const cashierLabel = profile?.displayName?.trim() || profile?.email?.trim() || sale.cashierId;
    const deviceLabel = describeDevice(
        sale,
        sale.deviceId ? deviceNames.get(sale.deviceId) ?? null : null,
        cashierLabel,
    );
    const occurred = (sale.occurredAt ?? sale.createdAt).toDate();

    await sendReportEmail({
        subject: unreconciledSaleSubject(sale.total, deviceLabel),
        react: UnreconciledSaleAlertEmail({
            deviceLabel,
            total: sale.total,
            cashierLabel,
            occurredLocal: formatLocalDateTime(occurred),
            localFolio: sale.localFolio,
            reason: sale.reason,
        }),
    });
};
