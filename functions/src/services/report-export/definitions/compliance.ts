import { CONTROLLED_GROUP_RULES } from '../../../constants/controlled';
import * as auditRepo from '../../../repositories/audit-logs.repository';
import * as ledgerRepo from '../../../repositories/controlled-ledger.repository';
import { ControlledLedgerType } from '../../../types';
import { assertCanExportControlledLedger } from '../../controlled.service';
import { NO_CASHIER, resolveUserNames } from '../../module-reports.service';
import { ReportDefinition } from '../report-definition';
import { getMaxReportSpanDays } from '../../../utils/report-range';
import { resolveReportPeriod } from '../period';
import { MAX_ROWS, stampDate, stampTime } from './shared';

const LEDGER_TYPE_LABELS: Record<ControlledLedgerType, string> = {
    sale: 'Venta',
    void: 'Anulación',
    return: 'Devolución',
};

export const libroControlados: ReportDefinition = {
    key: 'libro-controlados',
    title: 'Libro de control de medicamentos controlados',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'time', header: 'Hora', type: 'text' },
        { key: 'movement', header: 'Movimiento', type: 'text' },
        { key: 'saleFolio', header: 'Folio venta', type: 'text' },
        { key: 'refFolio', header: 'Folio devolución', type: 'text' },
        { key: 'group', header: 'Grupo', type: 'text' },
        { key: 'product', header: 'Producto', type: 'text' },
        { key: 'quantity', header: 'Cantidad', type: 'int', total: true },
        { key: 'lots', header: 'Lotes', type: 'text' },
        { key: 'doctor', header: 'Médico', type: 'text' },
        { key: 'license', header: 'Cédula', type: 'text' },
        { key: 'prescription', header: 'Folio receta', type: 'text' },
        { key: 'retained', header: 'Receta retenida', type: 'text' },
        { key: 'customer', header: 'Cliente', type: 'text' },
        { key: 'user', header: 'Usuario', type: 'text' },
    ],
    // Vuelca el nombre de cada paciente y la cédula de cada médico del periodo, así
    // que lleva la misma restricción que el CSV del libro: administrador o gerente.
    authorize: ({ roleSlug }) => assertCanExportControlledLedger(roleSlug),
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now, getMaxReportSpanDays('financial'));
        const entries = await ledgerRepo.listLedgerEntries({ from: range.from, to: range.to });
        const names = await resolveUserNames(entries.map((entry) => entry.userId));
        const rows = [...entries]
            .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
            .map((entry) => ({
                date: stampDate(entry.createdAt),
                time: stampTime(entry.createdAt),
                movement: LEDGER_TYPE_LABELS[entry.type],
                saleFolio: entry.saleFolio,
                refFolio: entry.referenceFolio ?? '',
                // Un renglón sin grupo válido no tumba la exportación ni se presenta con grupo.
                group: CONTROLLED_GROUP_RULES[entry.controlledGroup]?.label
                    ?? 'Sin grupo registrado',
                product: entry.productName,
                quantity: entry.quantity,
                lots: entry.lotNumbers.join(' | '),
                doctor: entry.prescription?.doctorName ?? '',
                license: entry.prescription?.doctorLicense ?? '',
                prescription: entry.prescription?.folio ?? '',
                retained: entry.prescriptionRetained ? 'Sí' : 'No',
                customer: entry.customerName ?? '',
                user: names.get(entry.userId) ?? NO_CASHIER,
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin movimientos de medicamentos controlados en el periodo.',
            notes: ['Anulaciones y devoluciones se asientan con cantidad negativa; '
                + 'no se borra ningún renglón.'],
        };
    },
};

export const bitacora: ReportDefinition = {
    key: 'bitacora',
    title: 'Bitácora de auditoría',
    columns: [
        { key: 'date', header: 'Fecha', type: 'text' },
        { key: 'time', header: 'Hora', type: 'text' },
        { key: 'action', header: 'Acción', type: 'text' },
        { key: 'entity', header: 'Entidad', type: 'text' },
        { key: 'summary', header: 'Resumen', type: 'text' },
        { key: 'user', header: 'Usuario', type: 'text' },
        { key: 'role', header: 'Rol', type: 'text' },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now, getMaxReportSpanDays('financial'));
        const logs = await auditRepo.listAuditLogs({ from: range.from, to: range.to });
        const ordered = [...logs].sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
        const shown = ordered.slice(0, MAX_ROWS);
        const names = await resolveUserNames(shown.map((log) => log.userId));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: shown.map((log) => ({
                date: stampDate(log.createdAt),
                time: stampTime(log.createdAt),
                action: log.action,
                entity: log.entity,
                summary: log.summary,
                user: names.get(log.userId) ?? (log.userId === 'system' ? 'Sistema' : NO_CASHIER),
                role: log.roleSlug ?? '',
            })),
            emptyMessage: 'Sin movimientos auditados en el periodo.',
            notes: ordered.length > MAX_ROWS
                ? [`Se muestran los primeros ${MAX_ROWS} de ${ordered.length} movimientos; `
                    + 'acota el rango.']
                : ['Cubre dinero, precios y accesos; las altas rutinarias no se auditan.'],
        };
    },
};

export const complianceDefinitions: ReportDefinition[] = [libroControlados, bitacora];
