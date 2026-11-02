#!/usr/bin/env bash
# SPEC 31 req. 1 — Activa PITR (7 días) en la base (default) de producción.
#
# Uso:
#   PROJECT=farma-jyv scripts/ops/31-pitr.sh            # en seco: imprime los comandos
#   PROJECT=farma-jyv scripts/ops/31-pitr.sh --apply    # aplica y verifica
#
# Idempotente: volver a activar PITR no cambia nada. PITR se cobra aparte
# (almacenamiento de versiones); anotar el costo del primer mes en RUNBOOK §4.
# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

PROJECT="${PROJECT:-farma-jyv}"
banner "PITR en ${PROJECT}"

run gcloud firestore databases update --database='(default)' --enable-pitr --project="${PROJECT}"

# Criterio de aceptación: debe imprimir POINT_IN_TIME_RECOVERY_ENABLED.
run gcloud firestore databases describe --database='(default)' --project="${PROJECT}" \
    --format='value(pointInTimeRecoveryEnablement,versionRetentionPeriod,earliestVersionTime)'
