// Reglas puras del simulacro de restauración (SPEC 43); restore-drill.mjs las usa.
import { PROTECTED_PROJECTS } from './cli.mjs';

export const DRILL_COLLECTIONS = ['sales', 'batches', 'products', 'cashSessions'];

/** Campos que una venta y un corte completos siempre tienen (types/index.ts). */
export const REQUIRED_FIELDS = {
    sales: ['folio', 'items', 'subtotal', 'total', 'paymentMethod', 'cashierId', 'createdAt'],
    cashSessions: ['openedBy', 'openingAmount', 'openedAt', 'closedAt', 'countedCashAmount'],
};

/**
 * El destino del import no puede ser un proyecto con aplicaciones (requisito 7).
 * Se valida antes de cualquier otra cosa, también en seco.
 */
export const assertDrillTarget = (project, sourceProject) => {
    if (!project) throw new Error('Falta --project (el proyecto aislado de respaldos)');
    if (PROTECTED_PROJECTS.includes(project) || project === sourceProject || /^demo-/.test(project)) {
        throw new Error(
            `El simulacro nunca importa en ${project}: el único destino es el proyecto de respaldos`,
        );
    }
};

/** `firestore-backups/2026-11-02T08-00-00/` → Date de esa carpeta (UTC). */
export const exportTimeOf = (folder) => {
    const match = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\/?$/.exec(folder);
    return match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : null;
};

/**
 * Elige el export completo más reciente. Un export a medias no tiene su
 * `.overall_export_metadata` y no se puede importar: se salta y se anota el hueco.
 */
export const pickLatestExport = (objectPaths) => {
    const folders = new Map();
    for (const path of objectPaths) {
        const match = /^(gs:\/\/[^/]+\/firestore-backups\/[^/]+\/)(.*)$/.exec(path.trim());
        if (!match) continue;
        const [, folder, rest] = match;
        const entry = folders.get(folder) ?? { folder, complete: false };
        if (rest.endsWith('.overall_export_metadata')) entry.complete = true;
        folders.set(folder, entry);
    }
    const ordered = [...folders.values()].sort((a, b) => b.folder.localeCompare(a.folder));
    const latest = ordered.find((entry) => entry.complete) ?? null;
    const skipped = latest ? ordered.slice(0, ordered.indexOf(latest)).map((entry) => entry.folder) : [];
    return { latest: latest?.folder ?? null, skipped };
};

/** PITR lee a minutos enteros más allá de la última hora. */
export const prodReadTimeFor = (exportTime, now = new Date()) => {
    if (!exportTime) return null;
    const minute = new Date(Math.floor(exportTime.getTime() / 60_000) * 60_000);
    return now.getTime() - minute.getTime() < 7 * 86_400_000 ? minute : null;
};


/**
 * El export de las 02:00 (CDMX) trae completo el día local anterior: devuelve
 * ese día como intervalo UTC `[start, end)`. CDMX es UTC−6 fijo desde 2022.
 */
export const localDayBefore = (exportTime) => {
    const offset = 6 * 3_600_000;
    const day = 86_400_000;
    const end = new Date(exportTime.getTime() - ((exportTime.getTime() - offset) % day));
    return { start: new Date(end.getTime() - day), end };
};
