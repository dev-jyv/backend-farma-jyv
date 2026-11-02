#!/usr/bin/env bash
# Workload Identity Federation para desplegar desde GitHub Actions (SPEC 39).
#
# NO lo corre el pipeline ni ningún agente: lo ejecuta UNA vez por proyecto el
# dueño de la cuenta, con `gcloud auth login` (RUNBOOK §8.1). Es idempotente:
# lo que ya existe se reporta y se sigue.
#
#   scripts/ci/setup-wif.sh farma-jyv-dev
#   scripts/ci/setup-wif.sh farma-jyv
#
# Crea, en el proyecto indicado:
#   - Pool `github-actions` y proveedor OIDC `github`, que solo acepta tokens de
#     dev-jyv/backend-farma-jyv y dev-jyv/farma-jyv-admin, y además:
#       farma-jyv-dev → solo la rama main y el environment `dev`;
#       farma-jyv     → solo tags v* y el environment `production`.
#   - `deploy-backend@`: Functions, reglas de Firestore y Storage, índices.
#     Solo la puede suplantar el repo del backend.
#   - `deploy-admin@`: solo Hosting. Solo la puede suplantar el repo del panel.
# Ninguna cuenta tiene llave: `iam.serviceAccountKeys.create` no se usa nunca.
#
# Al final imprime los valores de las variables de GitHub
# (`GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`) para cada repo.
#
# Roles: el mínimo conocido para `firebase deploy`. Si un deploy falla con
# PERMISSION_DENIED por un permiso concreto, añade el rol que lo contiene aquí y
# en el RUNBOOK, no `roles/owner` ni `roles/editor`.
set -euo pipefail

PROJECT_ID="${1:?Uso: setup-wif.sh <farma-jyv|farma-jyv-dev>}"
OWNER="dev-jyv"
BACKEND_REPO="${OWNER}/backend-farma-jyv"
ADMIN_REPO="${OWNER}/farma-jyv-admin"
POOL="github-actions"
PROVIDER="github"

case "${PROJECT_ID}" in
    farma-jyv-dev)
        CONDITION="assertion.repository_owner == '${OWNER}' && assertion.repository in ['${BACKEND_REPO}', '${ADMIN_REPO}'] && assertion.ref == 'refs/heads/main' && assertion.environment == 'dev'"
        ;;
    farma-jyv)
        CONDITION="assertion.repository_owner == '${OWNER}' && assertion.repository in ['${BACKEND_REPO}', '${ADMIN_REPO}'] && assertion.ref.startsWith('refs/tags/v') && assertion.environment == 'production'"
        ;;
    *)
        echo "Proyecto no permitido: ${PROJECT_ID}" >&2
        exit 1
        ;;
esac

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
POOL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
# Cuenta con la que corren las funciones (la de cómputo por defecto, RUNBOOK §4).
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
    --project="${PROJECT_ID}"

gcloud iam workload-identity-pools describe "${POOL}" \
    --project="${PROJECT_ID}" --location=global >/dev/null 2>&1 ||
    gcloud iam workload-identity-pools create "${POOL}" \
        --project="${PROJECT_ID}" --location=global \
        --display-name="GitHub Actions"

PROVIDER_ARGS=(
    --project="${PROJECT_ID}" --location=global --workload-identity-pool="${POOL}"
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment"
    --attribute-condition="${CONDITION}"
)
if gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
    --project="${PROJECT_ID}" --location=global --workload-identity-pool="${POOL}" \
    >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers update-oidc "${PROVIDER}" "${PROVIDER_ARGS[@]}"
else
    gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" "${PROVIDER_ARGS[@]}" \
        --display-name="GitHub" --issuer-uri="https://token.actions.githubusercontent.com"
fi

ensure_sa() {
    local name="$1" display="$2"
    gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --project="${PROJECT_ID}" >/dev/null 2>&1 ||
        gcloud iam service-accounts create "${name}" \
            --project="${PROJECT_ID}" --display-name="${display}"
}

grant() {
    local sa="$1" role="$2"
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
        --member="serviceAccount:${sa}" --role="${role}" --condition=None >/dev/null
    echo "  ${role}"
}

allow_repo() {
    local sa="$1" repo="$2"
    gcloud iam service-accounts add-iam-policy-binding "${sa}" \
        --project="${PROJECT_ID}" --role="roles/iam.workloadIdentityUser" \
        --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${repo}" \
        >/dev/null
}

# --- Backend: functions, firestore:rules, firestore:indexes, storage ---
BACKEND_SA="deploy-backend@${PROJECT_ID}.iam.gserviceaccount.com"
ensure_sa deploy-backend "Deploy backend desde GitHub Actions"
echo "Roles de ${BACKEND_SA}:"
for role in \
    roles/cloudfunctions.developer \
    roles/run.admin \
    roles/cloudscheduler.admin \
    roles/artifactregistry.reader \
    roles/firebaserules.admin \
    roles/datastore.indexAdmin \
    roles/firebasestorage.viewer \
    roles/firebase.viewer \
    roles/secretmanager.viewer \
    roles/serviceusage.serviceUsageConsumer; do
    grant "${BACKEND_SA}" "${role}"
done
# Desplegar una función que corre como RUNTIME_SA exige poder "actuar como" ella;
# se concede sobre esa cuenta, no sobre todo el proyecto.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
    --project="${PROJECT_ID}" --role="roles/iam.serviceAccountUser" \
    --member="serviceAccount:${BACKEND_SA}" >/dev/null
allow_repo "${BACKEND_SA}" "${BACKEND_REPO}"

# --- Panel: solo Hosting ---
ADMIN_SA="deploy-admin@${PROJECT_ID}.iam.gserviceaccount.com"
ensure_sa deploy-admin "Deploy panel desde GitHub Actions"
echo "Roles de ${ADMIN_SA}:"
for role in \
    roles/firebasehosting.admin \
    roles/firebase.viewer \
    roles/serviceusage.serviceUsageConsumer; do
    grant "${ADMIN_SA}" "${role}"
done
allow_repo "${ADMIN_SA}" "${ADMIN_REPO}"

ENVIRONMENT=$([ "${PROJECT_ID}" = "farma-jyv" ] && echo production || echo dev)
cat <<EOF

Listo. Variables del environment \`${ENVIRONMENT}\` en GitHub:

  ${BACKEND_REPO}
    GCP_WORKLOAD_IDENTITY_PROVIDER = ${POOL_ID}/providers/${PROVIDER}
    GCP_DEPLOY_SERVICE_ACCOUNT     = ${BACKEND_SA}

  ${ADMIN_REPO}
    GCP_WORKLOAD_IDENTITY_PROVIDER = ${POOL_ID}/providers/${PROVIDER}
    GCP_DEPLOY_SERVICE_ACCOUNT     = ${ADMIN_SA}
EOF
