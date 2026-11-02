#!/usr/bin/env bash
# Espera a que ningún índice compuesto de Firestore siga en CREATING (SPEC 39,
# RUNBOOK §1 y §2e). `firebase deploy --only firestore:indexes` regresa en cuanto
# pide la construcción; una función desplegada antes de que su índice esté READY
# responde 500 (FAILED_PRECONDITION). Por eso el job de despliegue no publica
# funciones hasta que este script sale en 0.
#
# Uso: scripts/ci/wait-firestore-indexes.sh <projectId> [segundos_maximos]
# Requiere gcloud autenticado (en Actions: google-github-actions/auth).
set -euo pipefail

PROJECT_ID="${1:?Uso: wait-firestore-indexes.sh <projectId> [segundos_maximos]}"
TIMEOUT_SECONDS="${2:-${INDEX_WAIT_TIMEOUT_SECONDS:-1800}}"
INTERVAL_SECONDS="${INDEX_WAIT_INTERVAL_SECONDS:-20}"
START=$(date +%s)

while true; do
    STATES=$(gcloud firestore indexes composite list \
        --project="${PROJECT_ID}" --format="value(state)")
    CREATING=$(grep -c '^CREATING$' <<<"${STATES}" || true)
    REPAIR=$(grep -c '^NEEDS_REPAIR$' <<<"${STATES}" || true)
    TOTAL=$(grep -c . <<<"${STATES}" || true)

    if [ "${REPAIR}" -gt 0 ]; then
        echo "::error::${REPAIR} índice(s) de ${PROJECT_ID} en NEEDS_REPAIR. No se despliegan funciones; revisa 'gcloud firestore indexes composite list --project=${PROJECT_ID}'."
        exit 1
    fi

    if [ "${CREATING}" -eq 0 ]; then
        echo "Índices de ${PROJECT_ID} listos: ${TOTAL} compuestos, ninguno en CREATING."
        exit 0
    fi

    ELAPSED=$(( $(date +%s) - START ))
    if [ "${ELAPSED}" -ge "${TIMEOUT_SECONDS}" ]; then
        echo "::error::Tras ${ELAPSED}s quedan ${CREATING} índice(s) en CREATING en ${PROJECT_ID}. No se despliegan funciones. Cuando terminen, relanza el job (RUNBOOK §10)."
        exit 1
    fi

    echo "${CREATING} de ${TOTAL} índice(s) en CREATING en ${PROJECT_ID} (${ELAPSED}s); esperando ${INTERVAL_SECONDS}s…"
    sleep "${INTERVAL_SECONDS}"
done
