#!/usr/bin/env bash
# SPEC 31 req. 2 y SPEC 43 req. 1 — Proyecto aislado de respaldos y su bucket.
#
# Variables:
#   BACKUP_PROJECT     id del proyecto nuevo (p. ej. farma-jyv-respaldos). Nunca farma-jyv(-dev).
#   EXTERNAL_BUCKET    bucket destino de la copia (sin gs://), p. ej. farma-jyv-respaldos-externo.
#   BILLING_ACCOUNT    cuenta de facturación (XXXXXX-XXXXXX-XXXXXX).
#   OWNER_ACCOUNT      correo del dueño de la cuenta (queda como owner).
#   DRILL_ACCOUNT      correo de quien ejecuta los simulacros (opcional si es el dueño).
#   SOURCE_PROJECT     proyecto de producción (default farma-jyv), solo se lee.
#   SOURCE_BUCKET      bucket de los exports nocturnos (default farma-jyv-respaldos-firestore).
#
# Uso:
#   BACKUP_PROJECT=... EXTERNAL_BUCKET=... BILLING_ACCOUNT=... OWNER_ACCOUNT=... \
#     scripts/ops/31-backup-project.sh            # en seco
#   ... scripts/ops/31-backup-project.sh --apply  # aplica (idempotente)
#
# No crea Firebase, Hosting ni funciones en el proyecto (SPEC 43 req. 1). Al
# final imprime la política IAM y marca cualquier miembro que no sea el dueño,
# quien ejecuta el simulacro o un agente de servicio de Google.
# shellcheck source=scripts/ops/lib.sh
source "$(dirname "$0")/lib.sh"

need BACKUP_PROJECT; need EXTERNAL_BUCKET; need BILLING_ACCOUNT; need OWNER_ACCOUNT
assert_not_protected "${BACKUP_PROJECT}"
SOURCE_PROJECT="${SOURCE_PROJECT:-farma-jyv}"
SOURCE_BUCKET="${SOURCE_BUCKET:-farma-jyv-respaldos-firestore}"
DRILL_ACCOUNT="${DRILL_ACCOUNT:-${OWNER_ACCOUNT}}"
[[ "${EXTERNAL_BUCKET}" != "${SOURCE_BUCKET}" ]] || die "EXTERNAL_BUCKET no puede ser el bucket origen"

banner "proyecto ${BACKUP_PROJECT} y bucket gs://${EXTERNAL_BUCKET}"

# 1. Proyecto y facturación.
if ! exists gcloud projects describe "${BACKUP_PROJECT}"; then
    run gcloud projects create "${BACKUP_PROJECT}" --name="FarmaJyV respaldos"
fi
run gcloud billing projects link "${BACKUP_PROJECT}" --billing-account="${BILLING_ACCOUNT}"

# 2. Solo las APIs que usan la copia, el simulacro y su alerta.
run gcloud services enable storage.googleapis.com storagetransfer.googleapis.com \
    firestore.googleapis.com pubsub.googleapis.com monitoring.googleapis.com \
    --project="${BACKUP_PROJECT}"

# 3. Bucket en la misma ubicación que el origen: los exports de producción ya se
#    escriben ahí, así que un import desde una base en la región de producción
#    también funciona (SPEC 43: la región se fija igual a la de farma-jyv).
if [[ "$APPLY" == 1 ]]; then
    LOCATION="$(gcloud storage buckets describe "gs://${SOURCE_BUCKET}" --format='value(location)')"
else
    LOCATION="<ubicación de gs://${SOURCE_BUCKET}>"
fi
if ! exists gcloud storage buckets describe "gs://${EXTERNAL_BUCKET}" --project="${BACKUP_PROJECT}"; then
    run gcloud storage buckets create "gs://${EXTERNAL_BUCKET}" --project="${BACKUP_PROJECT}" \
        --location="${LOCATION}" --uniform-bucket-level-access --public-access-prevention
fi
# Versionado: un borrado deja la versión anterior 30 días. Retención: 30 días
# sobre firestore-backups/ (la misma que el origen, pero con su propio reloj).
run gcloud storage buckets update "gs://${EXTERNAL_BUCKET}" --versioning \
    --lifecycle-file="$(dirname "$0")/defs/storage/lifecycle-external.json"

# 4. IAM del proyecto: solo el dueño y quien ejecuta el simulacro.
run gcloud projects add-iam-policy-binding "${BACKUP_PROJECT}" \
    --member="user:${OWNER_ACCOUNT}" --role=roles/owner --condition=None --format=none
if [[ "${DRILL_ACCOUNT}" != "${OWNER_ACCOUNT}" ]]; then
    for role in roles/datastore.owner roles/datastore.importExportAdmin roles/storage.objectViewer; do
        run gcloud projects add-iam-policy-binding "${BACKUP_PROJECT}" \
            --member="user:${DRILL_ACCOUNT}" --role="${role}" --condition=None --format=none
    done
fi

# 5. El permiso de lectura del agente de Firestore sobre el bucket externo lo
#    concede `restore-drill.mjs preflight`, después de crear la base: el agente
#    no existe hasta entonces y la concesión fallaría aquí.

# 6. Auditoría de la política IAM (criterio de aceptación de SPEC 43).
if [[ "$APPLY" == 1 ]]; then
    echo "Miembros con acceso a ${BACKUP_PROJECT}:"
    gcloud projects get-iam-policy "${BACKUP_PROJECT}" \
        --flatten='bindings[].members' --format='value(bindings.members)' | sort -u |
    while read -r member; do
        case "$member" in
            "user:${OWNER_ACCOUNT}"|"user:${DRILL_ACCOUNT}") echo "  ok    ${member}" ;;
            serviceAccount:service-*@gcp-sa-*|serviceAccount:*@storage-transfer-service.iam.gserviceaccount.com|serviceAccount:*@cloudservices.gserviceaccount.com)
                echo "  agente ${member} (gestionado por Google)" ;;
            *) echo "  ✗ SOBRA ${member}: quitarlo (SPEC 43 req. 1)" ;;
        esac
    done
else
    echo "[en seco] gcloud projects get-iam-policy ${BACKUP_PROJECT} → marcar miembros que sobren"
fi

echo "Siguiente: node scripts/ops/gcp.mjs transfer --project ${BACKUP_PROJECT} --dest-bucket ${EXTERNAL_BUCKET}"
