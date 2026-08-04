import { ControlledGroup } from '../types';

/**
 * Grupos de medicamentos de la Ley General de Salud / COFEPRIS (art. 226).
 *
 *  I   — estupefacientes: receta especial con código de barras, se retiene.
 *  II  — psicotrópicos: receta especial, se retiene.
 *  III — psicotrópicos de menor riesgo: receta médica que se retiene.
 *  IV  — antibióticos y otros de receta: receta médica, se sella y se devuelve.
 *  V   — venta sin receta en farmacia.
 *  VI  — venta libre (incluye fuera de farmacia).
 *
 * `requiresLedger` marca los grupos que deben quedar en el libro de control
 * (`controlledSalesLedger`), que es lo que se muestra en una visita de COFEPRIS.
 */
export interface ControlledGroupRule {
    group: ControlledGroup;
    label: string;
    requiresPrescription: boolean;
    /** El folio de la receta es obligatorio, no opcional. */
    requiresFolio: boolean;
    /** La receta se queda en la farmacia; el cajero debe confirmarlo. */
    retainsPrescription: boolean;
    requiresLedger: boolean;
}

export const CONTROLLED_GROUP_RULES: Record<ControlledGroup, ControlledGroupRule> = {
    I: {
        group: 'I',
        label: 'Grupo I (estupefacientes)',
        requiresPrescription: true,
        requiresFolio: true,
        retainsPrescription: true,
        requiresLedger: true,
    },
    II: {
        group: 'II',
        label: 'Grupo II (psicotrópicos)',
        requiresPrescription: true,
        requiresFolio: true,
        retainsPrescription: true,
        requiresLedger: true,
    },
    III: {
        group: 'III',
        label: 'Grupo III (psicotrópicos)',
        requiresPrescription: true,
        requiresFolio: true,
        retainsPrescription: true,
        requiresLedger: true,
    },
    IV: {
        group: 'IV',
        label: 'Grupo IV (antibióticos y otros de receta)',
        requiresPrescription: true,
        requiresFolio: false,
        // La receta se sella y se devuelve al paciente, pero la venta sí se registra.
        retainsPrescription: false,
        requiresLedger: true,
    },
    V: {
        group: 'V',
        label: 'Grupo V (venta en farmacia sin receta)',
        requiresPrescription: false,
        requiresFolio: false,
        retainsPrescription: false,
        requiresLedger: false,
    },
    VI: {
        group: 'VI',
        label: 'Grupo VI (venta libre)',
        requiresPrescription: false,
        requiresFolio: false,
        retainsPrescription: false,
        requiresLedger: false,
    },
};

export const CONTROLLED_GROUPS: ControlledGroup[] = ['I', 'II', 'III', 'IV', 'V', 'VI'];

export const getControlledRule = (
    group?: ControlledGroup,
): ControlledGroupRule | null => (group ? CONTROLLED_GROUP_RULES[group] : null);
