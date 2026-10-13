import * as appointmentsRepo from '../../../repositories/appointments.repository';
import { AppointmentStatus, ServiceType } from '../../../types';
import { getCommissionsByProvider, getServicesSummary } from '../../analytics.service';
import { ReportDefinition } from '../report-definition';
import { resolveReportPeriod } from '../period';

export const comisiones: ReportDefinition = {
    key: 'comisiones',
    title: 'Servicios y comisiones por médico',
    columns: [
        { key: 'doctor', header: 'Médico', type: 'text' },
        { key: 'services', header: 'Servicios', type: 'int', total: true },
        { key: 'base', header: 'Base de comisión', type: 'money', total: true },
        { key: 'commission', header: 'Comisión', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getCommissionsByProvider({ from: range.from, to: range.to });
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: report.items.map((item) => ({
                doctor: item.providerName ?? 'Sin doctor asignado',
                services: item.servicesCount,
                base: item.base,
                commission: item.commissionTotal,
            })),
            emptyMessage: 'Sin servicios cobrados en el periodo.',
            notes: ['La comisión se calcula sobre el importe neto cobrado por el servicio.'],
        };
    },
};

const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
    consultation: 'Consultas',
    procedure: 'Procedimientos',
    other: 'Otros servicios',
};

export const servicios: ReportDefinition = {
    key: 'servicios',
    title: 'Ingresos del consultorio por tipo de servicio',
    columns: [
        { key: 'type', header: 'Tipo', type: 'text' },
        { key: 'services', header: 'Servicios', type: 'int', total: true },
        { key: 'total', header: 'Cobrado', type: 'money', total: true },
        { key: 'commission', header: 'Comisión', type: 'money', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const report = await getServicesSummary({ from: range.from, to: range.to });
        return {
            subtitle: range.label,
            slug: range.slug,
            rows: report.byType.map((item) => ({
                type: SERVICE_TYPE_LABELS[item.serviceType] ?? item.serviceType,
                services: item.servicesCount,
                total: item.total,
                commission: item.commissionTotal,
            })),
            notes: [
                `${report.salesCount} ventas cobraron al menos un servicio; entró a caja `
                + `en efectivo $${report.cashTotal.toFixed(2)} por servicios.`,
            ],
        };
    },
};

const STATUS_COLUMNS: Array<{ status: AppointmentStatus; key: string; header: string }> = [
    { status: 'scheduled', key: 'scheduled', header: 'Programadas' },
    { status: 'confirmed', key: 'confirmed', header: 'Confirmadas' },
    { status: 'in_progress', key: 'inProgress', header: 'En curso' },
    { status: 'completed', key: 'completed', header: 'Atendidas' },
    { status: 'cancelled', key: 'cancelled', header: 'Canceladas' },
    { status: 'no_show', key: 'noShow', header: 'No asistió' },
];

/**
 * Solo conteos por médico y estado. No lee ni muestra motivo, notas ni el nombre del
 * paciente: el expediente es dato sensible y este reporte lo ve quien tiene `dashboard`.
 */
export const citas: ReportDefinition = {
    key: 'citas',
    title: 'Citas por médico y estado',
    columns: [
        { key: 'doctor', header: 'Médico', type: 'text' },
        ...STATUS_COLUMNS.map(({ key, header }) => ({
            key,
            header,
            type: 'int' as const,
            total: true,
        })),
        { key: 'total', header: 'Total', type: 'int', total: true },
    ],
    load: async ({ query, now }) => {
        const range = resolveReportPeriod(query, now);
        const appointments = await appointmentsRepo.listAppointmentsInRange({
            from: range.from,
            to: range.to,
        });
        const byDoctor = new Map<string, Record<string, number>>();
        for (const appointment of appointments) {
            const counts = byDoctor.get(appointment.doctorName) ?? {};
            const column = STATUS_COLUMNS.find((item) => item.status === appointment.status);
            if (column) {
                counts[column.key] = (counts[column.key] ?? 0) + 1;
            }
            counts.total = (counts.total ?? 0) + 1;
            byDoctor.set(appointment.doctorName, counts);
        }
        const rows = [...byDoctor.entries()]
            .sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0) || a[0].localeCompare(b[0], 'es'))
            .map(([doctor, counts]) => ({
                doctor,
                ...Object.fromEntries(STATUS_COLUMNS.map(({ key }) => [key, counts[key] ?? 0])),
                total: counts.total ?? 0,
            }));
        return {
            subtitle: range.label,
            slug: range.slug,
            rows,
            emptyMessage: 'Sin citas en el periodo.',
            notes: ['La cita no guarda monto: los ingresos del consultorio salen de las ventas de '
                + 'servicios (reporte "Ingresos del consultorio").'],
        };
    },
};

export const clinicDefinitions: ReportDefinition[] = [comisiones, servicios, citas];
