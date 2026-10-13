import { ReportDefinition } from './report-definition';
import { clinicDefinitions } from './definitions/clinic';
import { complianceDefinitions } from './definitions/compliance';
import { financialDefinitions } from './definitions/financial';
import { inventoryDefinitions } from './definitions/inventory';
import { purchasingDefinitions } from './definitions/purchasing';
import { salesDefinitions } from './definitions/sales';

/**
 * Única lista de reportes exportables. La ruta valida `:report` contra `REPORT_KEYS`,
 * derivado de aquí: un reporte nuevo se registra una vez y la validación lo sigue.
 */
const ALL: ReportDefinition[] = [
    ...financialDefinitions,
    ...inventoryDefinitions,
    ...salesDefinitions,
    ...complianceDefinitions,
    ...clinicDefinitions,
    ...purchasingDefinitions,
];

export const REPORT_REGISTRY: ReadonlyMap<string, ReportDefinition> = new Map(
    ALL.map((definition) => [definition.key, definition]),
);

export const REPORT_KEYS = ALL.map((definition) => definition.key) as [string, ...string[]];
