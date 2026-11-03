#!/usr/bin/env bash
# Valida un nombre de rama contra la convención de bambu-git-flow.
# Uso: validate-branch-name.sh <nombre-de-rama>
set -euo pipefail

branch="${1:-}"
if [[ -z "$branch" ]]; then
  echo "Uso: $0 <nombre-de-rama>" >&2
  exit 2
fi

max_len=50
pattern='^(feature|fix|hotfix|refactor|chore|docs)/[a-z0-9]+(-[a-z0-9]+)+$'

errors=()

if [[ ${#branch} -gt $max_len ]]; then
  errors+=("Excede el máximo de ${max_len} caracteres (tiene ${#branch}).")
fi

if [[ ! "$branch" =~ $pattern ]]; then
  errors+=("No cumple <tipo>/<modulo>-<descripcion>[-<ticket>] (tipo: feature|fix|hotfix|refactor|chore|docs; solo minúsculas, números y guiones; '/' solo después del tipo; sin mayúsculas, espacios ni guiones bajos; al menos módulo+descripción).")
fi

if [[ ${#errors[@]} -eq 0 ]]; then
  echo "OK: '$branch' cumple la convención de nombres."
  exit 0
fi

echo "INVÁLIDO: '$branch'" >&2
for e in "${errors[@]}"; do
  echo "  - $e" >&2
done
exit 1
